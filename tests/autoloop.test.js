#!/usr/bin/env node
// tests/autoloop.test.js
// Non-vacuous test for scripts/company-autoloop.js (threshold-driven design).
//
// VALIDATED HEADLESS REALITY (orchestrator real runs): a headless `claude -p`
// session does NOT self-trigger /company restart. The company Stop guards are
// interactive-only, so the supervisor OWNS the threshold decision: it reads the
// work session transcript, drives turns via --resume until fill crosses the
// threshold, then DRIVES `claude -p --resume <id> "/company restart"` to emit
// NEXT.md + RESTART_DEBATE_CONFIRMED, then seeds a FRESH --session-id from NEXT.md.
//
// The mock claude here, per invocation:
//   - parses --session-id / --resume to learn the work session id,
//   - APPENDS a usage block to a fake transcript at
//     <projectsDir>/proj/<sessionId>.jsonl with a TOKEN COUNT the test controls,
//     stepping fill across the threshold over successive turns,
//   - on a "/company restart" prompt: writes NEXT.md + RESTART_DEBATE_CONFIRMED
//     into COMPANY_DIR (real object schema) and records that a restart was driven,
//   - on a normal/continue prompt: does partial work (never marks done) unless the
//     mode is 'done' or 'cancel'.
// COMPANY_TRANSCRIPT_DIR points the supervisor at the fake projects root, and
// COMPANY_CONTEXT_WINDOW pins the window to 1000 so the token math is exact.
//
// Asserts:
//   (a) while fill < threshold the supervisor RESUMES the same session id (no
//       restart, no new session);
//   (b) when fill crosses the threshold the supervisor DRIVES `/company restart`
//       on that session id, then starts a NEW distinct session id whose first
//       prompt equals the NEXT.md content;
//   (c) goal-done (all-pass real-schema criteria) -> exit 0;
//   (d) CANCEL -> exit 0;
//   (e) NO invocation uses --continue, and the only --resume uses are
//       same-session-continue and the restart-drive (never to carry a fresh cycle).
//
// Non-vacuity proof (recorded verbatim in findings):
//   A fill-ignoring variant of the supervisor (never restarts, always resumes the
//   same session) is run against the same mock. It NEVER drives `/company restart`
//   and NEVER creates a second session, so assertion (b) FAILS against it. That is
//   the bar: a test the fixed design passes and the fill-ignoring design fails.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'company-autoloop.js');
const NEXT_CONTENT = 'CONTINUATION_PROMPT_FROM_RESTART';

let failures = 0;
let caseNo = 0;

function check(name, fn) {
  caseNo++;
  try {
    const err = fn();
    if (err) {
      console.log('FAIL case ' + caseNo + ' (' + name + '): ' + err);
      failures++;
    } else {
      console.log('ok: case ' + caseNo + ' ' + name);
    }
  } catch (e) {
    console.log('FAIL case ' + caseNo + ' (' + name + '): threw: ' + e.message);
    failures++;
  }
}

// ---------- shared setup ----------
function makeScratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoloop-test-'));
}

// Write a mock claude binary to scratch/bin/claude.
// It records argv per invocation (one JSON line in invFile), appends a usage
// block to the fake transcript for the work session, and handles restart/done/cancel.
//   tokensByCall: array of input_token counts indexed by NON-restart call number.
//     With COMPANY_CONTEXT_WINDOW=1000, a count of 300 is fill 0.30, 600 is 0.60.
//   mode 'restart': normal turns step tokens; a /company restart prompt writes
//                   NEXT.md + RESTART_DEBATE_CONFIRMED.
//   mode 'done':    every normal turn writes all-pass criteria.json.
//   mode 'cancel':  first normal turn touches CANCEL.
function writeMockClaude(scratch, companyDir, projectsDir, mode, tokensByCall) {
  const binDir = path.join(scratch, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mockPath = path.join(binDir, 'claude');
  const invFile = path.join(scratch, 'invocations.ndjson');
  const passEnvGate = "process.env.AUTOLOOP_TEST_PASSES === 'false' ? false : true";

  const mockSrc = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const invFile = ' + JSON.stringify(invFile) + ';',
    'const companyDir = process.env.COMPANY_DIR || ' + JSON.stringify(companyDir) + ';',
    'const projectsDir = ' + JSON.stringify(projectsDir) + ';',
    'const nextContent = ' + JSON.stringify(NEXT_CONTENT) + ';',
    'const mode = ' + JSON.stringify(mode) + ';',
    'const tokensByCall = ' + JSON.stringify(tokensByCall) + ';',
    'const argv = process.argv.slice(2);',
    'const record = { pid: process.pid, argv: argv };',
    "fs.appendFileSync(invFile, JSON.stringify(record) + '\\n');",
    'function argVal(f){ const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; }',
    "const sessionId = argVal('--session-id') || argVal('--resume');",
    "const prompt = argv[argv.length - 1];",
    'fs.mkdirSync(companyDir, { recursive: true });',
    'function writeDone() {',
    '  const passVal = ' + passEnvGate + ';',
    "  const criteria = { goal: 't', criteria: [{ id: 1, passes: passVal, evidence: 'x', stakes: 'normal' }] };",
    "  fs.writeFileSync(path.join(companyDir, 'criteria.json'), JSON.stringify(criteria));",
    '}',
    "const restartHangs = process.env.__MOCK_RESTART_HANGS === '1';",
    'function writeRestart() {',
    // NEXT.md first so its mtime is fresh, brief wait, then the confirmed marker.
    "  fs.writeFileSync(path.join(companyDir, 'NEXT.md'), nextContent);",
    '  const s = Date.now(); while (Date.now() - s < 30) {}',
    "  fs.writeFileSync(path.join(companyDir, 'RESTART_DEBATE_CONFIRMED'), JSON.stringify({ sessionId: 'mock' }));",
    '}',
    '// Append a usage block to the work session transcript so the supervisor can',
    '// read fill. Place it under projectsDir/proj/<sessionId>.jsonl.',
    'function appendUsage(tokens) {',
    '  if (!sessionId) return;',
    "  const projDir = path.join(projectsDir, 'proj');",
    '  fs.mkdirSync(projDir, { recursive: true });',
    "  const tp = path.join(projDir, sessionId + '.jsonl');",
    "  const line = JSON.stringify({ message: { role: 'assistant', model: 'test-model',",
    '    usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0,',
    "      cache_creation_input_tokens: 0 } } });",
    "  fs.appendFileSync(tp, line + '\\n');",
    '}',
    "const isRestart = prompt === '/company restart';",
    'if (isRestart) {',
    '  writeRestart();',
    '  // Simulate the real stop-guard-blocked restart invocation: markers are',
    '  // written, then the process NEVER exits. The supervisor must kill it.',
    '  if (restartHangs) {',
    "    process.on('SIGTERM', function () {});",
    '    setInterval(function () {}, 1000);',
    '    return;',
    '  }',
    '} else if (mode === "cancel") {',
    "  fs.writeFileSync(path.join(companyDir, 'CANCEL'), '');",
    '} else if (mode === "done") {',
    '  writeDone();',
    '} else {',
    '  // Normal work turn: step the token count for this NON-restart call.',
    "  const norm = fs.readFileSync(invFile, 'utf8').trim().split('\\n').filter(Boolean)",
    "    .map(function (l) { return JSON.parse(l); })",
    "    .filter(function (r) { return r.argv[r.argv.length - 1] !== '/company restart'; });",
    '  const idx = norm.length - 1;',
    '  const tokens = tokensByCall[idx] !== undefined ? tokensByCall[idx] : tokensByCall[tokensByCall.length - 1];',
    '  appendUsage(tokens);',
    '  // Simulate a work turn that writes partial state (the usage block above) and',
    '  // then HANGS FOREVER. The supervisor turn-timeout backstop must kill it. We',
    '  // catch SIGTERM so the kill must escalate to SIGKILL (the real run had this).',
    "  const workHangs = process.env.__MOCK_WORK_HANGS === '1';",
    '  if (workHangs) {',
    "    process.on('SIGTERM', function () {});",
    '    setInterval(function () {}, 1000);',
    '    return;',
    '  }',
    '}',
    '// Exit cleanly (expected headless behavior - a -p turn completes and exits).',
    'process.exit(0);',
  ].join('\n');

  fs.writeFileSync(mockPath, mockSrc, { mode: 0o755 });
  return { mockPath, binDir, invFile };
}

// Run the supervisor against the mock claude.
function runSupervisor(opts) {
  opts = opts || {};
  const scratch = opts.scratch || makeScratch();
  const companyDir = opts.companyDir || path.join(scratch, '.company');
  const projectsDir = opts.projectsDir || path.join(scratch, 'projects');
  const mode = opts.mode || 'restart';
  const tokensByCall = opts.tokensByCall || [300, 600];
  const { mockPath, binDir, invFile } =
    writeMockClaude(scratch, companyDir, projectsDir, mode, tokensByCall);
  const supervisorPath = opts.supervisorPath || SUPERVISOR;

  if (opts.preSetup) opts.preSetup(companyDir);

  const args = [
    supervisorPath,
    '--company-dir', companyDir,
    '--project-dir', scratch,
    '--projects-dir', projectsDir,
    '--max-turns', String(opts.maxTurns !== undefined ? opts.maxTurns : 6),
    '--permission-mode', 'bypassPermissions',
    '--restart-timeout-secs', String(opts.restartTimeoutSecs !== undefined ? opts.restartTimeoutSecs : 10),
  ];
  if (opts.turnTimeoutSecs !== undefined) {
    args.push('--turn-timeout-secs', String(opts.turnTimeoutSecs));
  }
  args.push('test-goal');

  const env = Object.assign({}, process.env, {
    CLAUDE_BIN: mockPath,
    COMPANY_DIR: companyDir,
    COMPANY_TRANSCRIPT_DIR: projectsDir,
    COMPANY_CONTEXT_WINDOW: '1000',
    COMPANY_CONTEXT_THRESHOLD: '0.50',
    PATH: binDir + path.delimiter + (process.env.PATH || ''),
  }, opts.extraEnv || {});

  const result = spawnSync(process.execPath, args, {
    env: env,
    cwd: scratch,
    encoding: 'utf8',
    timeout: opts.timeout !== undefined ? opts.timeout : 30000,
    killSignal: 'SIGKILL',
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    invFile: invFile,
    timedOut: result.error && result.error.code === 'ETIMEDOUT',
  };
}

function readInvocations(invFile) {
  if (!fs.existsSync(invFile)) return [];
  return fs.readFileSync(invFile, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(function (l) { return JSON.parse(l); });
}

function lastArg(argv) { return argv[argv.length - 1]; }
function sessionIdOf(argv) {
  let i = argv.indexOf('--session-id');
  if (i >= 0) return argv[i + 1];
  i = argv.indexOf('--resume');
  return i >= 0 ? argv[i + 1] : null;
}
function isFresh(argv) { return argv.indexOf('--session-id') !== -1; }
function isResume(argv) { return argv.indexOf('--resume') !== -1; }
function isRestartDrive(argv) { return lastArg(argv) === '/company restart'; }

// pidAlive: probe a pid with signal 0 (no signal sent, just an existence check).
function pidAlive(pid) {
  if (pid == null) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Reap any mock pids still alive (CI-safe cleanup, used in finally blocks).
function reapPids(invFile) {
  for (const inv of readInvocations(invFile)) {
    if (pidAlive(inv.pid)) {
      try { process.kill(inv.pid, 'SIGKILL'); } catch (e) {}
      // The mock leads its own group when spawned detached - kill the group too.
      try { process.kill(-inv.pid, 'SIGKILL'); } catch (e) {}
    }
  }
}

// ---------- Case 1: under-threshold resumes the SAME session, no restart ----------
// Turn 1 fill 0.30 (under). Turn 2 must RESUME the same session id, not restart,
// not create a new session. We pin both token steps under threshold and check the
// first two invocations share a session id and the 2nd is a --resume continue.
check('under threshold: supervisor resumes the SAME session (no restart, no new session)', function () {
  const r = runSupervisor({ mode: 'restart', tokensByCall: [300, 300, 300], maxTurns: 3 });
  const invs = readInvocations(r.invFile);
  if (invs.length < 2) {
    return 'expected >= 2 invocations (under-threshold continue), got ' + invs.length +
           '\nstderr: ' + r.stderr.slice(-400);
  }
  const work = invs.filter(function (i) { return !isRestartDrive(i.argv); });
  if (work.some(isRestartDrive)) return 'unexpected /company restart while under threshold';
  // No restart drive at all under threshold.
  if (invs.some(function (i) { return isRestartDrive(i.argv); })) {
    return 'supervisor drove /company restart while fill stayed under threshold';
  }
  // Invocation 1 is a fresh session, invocation 2 resumes the SAME id.
  if (!isFresh(invs[0].argv)) return 'invocation 1 was not a fresh --session-id';
  if (!isResume(invs[1].argv)) return 'invocation 2 was not a --resume continue';
  if (sessionIdOf(invs[0].argv) !== sessionIdOf(invs[1].argv)) {
    return 'under threshold the supervisor changed session id: ' +
      sessionIdOf(invs[0].argv) + ' -> ' + sessionIdOf(invs[1].argv);
  }
});

// ---------- Case 2: crossing threshold DRIVES restart, then FRESH session from NEXT.md ----------
check('threshold cross: drives /company restart then a NEW session seeded from NEXT.md', function () {
  const r = runSupervisor({ mode: 'restart', tokensByCall: [300, 600], maxTurns: 4 });
  const invs = readInvocations(r.invFile);
  // Find the restart-drive invocation.
  const restartIdx = invs.findIndex(function (i) { return isRestartDrive(i.argv); });
  if (restartIdx === -1) {
    return 'supervisor never drove /company restart after crossing threshold\nstderr: ' +
      r.stderr.slice(-500);
  }
  // The restart drive must be a --resume on the WORK session (the one that crossed).
  if (!isResume(invs[restartIdx].argv)) return 'restart drive was not a --resume';
  const workSession = sessionIdOf(invs[0].argv);
  if (sessionIdOf(invs[restartIdx].argv) !== workSession) {
    return 'restart drive ran on a different session than the work session';
  }
  // After the restart there must be a NEW fresh session whose prompt is NEXT.md.
  const after = invs.slice(restartIdx + 1).find(function (i) { return isFresh(i.argv); });
  if (!after) return 'no fresh session launched after the restart drive';
  if (lastArg(after.argv) !== NEXT_CONTENT) {
    return 'post-restart prompt mismatch.\n  got: ' + lastArg(after.argv) +
      '\n  expected: ' + NEXT_CONTENT;
  }
  if (sessionIdOf(after.argv) === workSession) {
    return 'post-restart session id is NOT distinct from the work session';
  }
});

// ---------- Case 3: goal done -> exit 0 ----------
check('goal done (all-pass real-schema criteria) exits 0', function () {
  const r = runSupervisor({ mode: 'done', maxTurns: 3 });
  if (r.code !== 0) {
    return 'expected exit 0 on done, got ' + r.code + '\nstderr: ' + r.stderr.slice(-400);
  }
});

// ---------- Case 4: CANCEL -> exit 0 ----------
check('CANCEL exits 0', function () {
  const r = runSupervisor({ mode: 'cancel', maxTurns: 3 });
  if (r.code !== 0) {
    return 'expected exit 0 on CANCEL, got ' + r.code + '\nstderr: ' + r.stderr.slice(-400);
  }
  if (r.stderr.indexOf('CANCEL') === -1) {
    return 'expected CANCEL mention in log, got: ' + r.stderr.slice(-300);
  }
});

// ---------- Case 5: no --continue; only legitimate --resume uses ----------
check('no --continue, every --resume continues a session that was started fresh', function () {
  const r = runSupervisor({ mode: 'restart', tokensByCall: [300, 600], maxTurns: 4 });
  const invs = readInvocations(r.invFile);
  // A session is "real" once it has been launched with --session-id. A --resume is
  // legitimate only if it targets such a session (same-session-continue or the
  // restart-drive on that same session). A --resume against an id never started
  // fresh would mean carrying work into a foreign/invented cycle.
  const freshIds = new Set();
  for (let i = 0; i < invs.length; i++) {
    const argv = invs[i].argv;
    if (argv.indexOf('--continue') !== -1) {
      return 'invocation ' + (i + 1) + ' passed --continue (forbidden)';
    }
    if (isFresh(argv)) {
      freshIds.add(sessionIdOf(argv));
    } else if (isResume(argv)) {
      if (!freshIds.has(sessionIdOf(argv))) {
        return 'invocation ' + (i + 1) + ' --resumed session ' + sessionIdOf(argv) +
          ' that was never started fresh (would carry work into a foreign cycle)';
      }
    }
  }
  // And the fresh-context handoff must be a NEW session, not a --resume carry.
  const restartIdx = invs.findIndex(function (i) { return isRestartDrive(i.argv); });
  if (restartIdx !== -1) {
    const after = invs.slice(restartIdx + 1).find(function (i) { return isFresh(i.argv); });
    if (!after) return 'no fresh --session-id handoff after the restart drive';
  }
});

// ---------- Case 6: passes:false is NOT done ----------
check('passes:false criteria object does not count as done', function () {
  const r = runSupervisor({ mode: 'done', maxTurns: 2, extraEnv: { AUTOLOOP_TEST_PASSES: 'false' } });
  if (r.code === 0) {
    return 'supervisor exited 0 with passes:false criteria (false positive done)';
  }
  if (r.stderr.indexOf('goal DONE') !== -1) {
    return 'supervisor logged goal DONE for passes:false criteria';
  }
});

// ---------- Case 7: NON-VACUITY - a fill-ignoring supervisor fails the threshold cross ----------
// Build a variant that NEVER restarts (ignores fill, always resumes the same
// session). Run the SAME mock that steps fill across the threshold. The variant
// must NEVER drive /company restart and NEVER create a second session, so the
// "restart at threshold" assertion from case 2 FAILS against it. We assert the
// variant's behavior, then confirm the real supervisor does the opposite.
check('NON-VACUITY: fill-ignoring supervisor never restarts, never spawns a 2nd session', function () {
  // A minimal supervisor that ignores fill: it loops, runs a fresh-then-resume
  // session, checks done/cancel, but NEVER computes fill and NEVER restarts.
  const variant = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { randomUUID } = require('node:crypto');",
    "const { spawnSync } = require('node:child_process');",
    'const argv = process.argv.slice(2);',
    'function argVal(f){ const i = argv.indexOf(f); return i >= 0 && argv[i+1] ? argv[i+1] : null; }',
    "const projectDir = path.resolve(argVal('--project-dir') || process.cwd());",
    "const companyDir = path.resolve(process.env.COMPANY_DIR || argVal('--company-dir') || path.join(projectDir, '.company'));",
    "const maxTurns = parseInt(argVal('--max-turns') || '6', 10);",
    "const permissionMode = argVal('--permission-mode') || 'bypassPermissions';",
    "const claudeBin = process.env.CLAUDE_BIN || 'claude';",
    "const prompt = argv[argv.length - 1];",
    "const criteriaPath = path.join(companyDir, 'criteria.json');",
    "const cancelPath = path.join(companyDir, 'CANCEL');",
    'function isDone(){ try { const p = JSON.parse(fs.readFileSync(criteriaPath, "utf8"));',
    '  const l = Array.isArray(p.criteria) ? p.criteria : (Array.isArray(p) ? p : []);',
    '  return l.length && l.every(c => c && c.passes === true); } catch(e){ return false; } }',
    'let sessionId = randomUUID();',
    'let fresh = true;',
    'for (let t = 1; t <= maxTurns; t++) {',
    '  if (fs.existsSync(cancelPath)) process.exit(0);',
    '  if (isDone()) process.exit(0);',
    "  const a = ['-p'];",
    "  if (fresh) a.push('--session-id', sessionId); else a.push('--resume', sessionId);",
    "  a.push('--permission-mode', permissionMode, fresh ? prompt : 'continue');",
    "  spawnSync(claudeBin, a, { cwd: projectDir, env: Object.assign({}, process.env, { COMPANY_DIR: companyDir }), encoding: 'utf8' });",
    '  if (fs.existsSync(cancelPath)) process.exit(0);',
    '  if (isDone()) process.exit(0);',
    '  // NEVER computes fill, NEVER restarts: just keeps resuming the same session.',
    '  fresh = false;',
    '}',
    'process.exit(3);',
  ].join('\n');

  const scratch = makeScratch();
  const variantPath = path.join(scratch, 'supervisor-fillignore.js');
  fs.writeFileSync(variantPath, variant);

  const r = runSupervisor({
    scratch: scratch,
    supervisorPath: variantPath,
    mode: 'restart',
    tokensByCall: [300, 600, 600, 600],
    maxTurns: 4,
  });
  const invs = readInvocations(r.invFile);

  // The fill-ignoring variant must NEVER drive /company restart.
  if (invs.some(function (i) { return isRestartDrive(i.argv); })) {
    return 'fill-ignoring variant unexpectedly drove /company restart - test is vacuous';
  }
  // And must NEVER create a second session id.
  const ids = new Set(invs.map(function (i) { return sessionIdOf(i.argv); }));
  if (ids.size >= 2) {
    return 'fill-ignoring variant created a second session (' + ids.size +
      ') - it should only ever resume one session';
  }

  process.stderr.write(
    '[autoloop.test] NON-VACUITY: fill-ignoring supervisor crossed the threshold ' +
    '(token steps 300->600 over ' + invs.length + ' invocations) yet NEVER drove ' +
    '/company restart and used ' + ids.size + ' distinct session id(s). The case-2 ' +
    'assertion (drive restart at threshold, then a NEW session from NEXT.md) FAILS ' +
    'against this variant. The threshold-driven restart path is load-bearing.\n'
  );
});

// ---------- Case 8: HUNG restart invocation is detected, killed, turn 2 proceeds ----------
// The real bug: `claude -p "/company restart"` writes the markers then NEVER exits
// (the company stop-guard blocks its stop). driveRestart must NOT await its exit.
// It must detect the markers concurrently, KILL the hung restart process group
// (the mock catches SIGTERM, so the kill must escalate to SIGKILL), and seed a
// fresh turn-2 session from NEXT.md. We assert: a restart was driven, that mock
// pid is GONE afterwards, and a NEW distinct session was launched with NEXT.md.
check('HUNG restart: markers detected, hung invocation killed, fresh turn 2 from NEXT.md', function () {
  let invFile;
  try {
    const r = runSupervisor({
      mode: 'restart',
      tokensByCall: [300, 600],
      maxTurns: 4,
      extraEnv: { __MOCK_RESTART_HANGS: '1' },
      restartTimeoutSecs: 15,
      timeout: 30000,
    });
    invFile = r.invFile;
    if (r.timedOut) {
      return 'supervisor TIMED OUT against a hung restart - driveRestart awaited the ' +
        'hung invocation instead of monitor-and-kill\nstderr: ' + r.stderr.slice(-500);
    }
    const invs = readInvocations(r.invFile);
    const restartIdx = invs.findIndex(function (i) { return isRestartDrive(i.argv); });
    if (restartIdx === -1) {
      return 'supervisor never drove /company restart\nstderr: ' + r.stderr.slice(-500);
    }
    // The hung restart invocation's pid must be GONE (killChildGroup reaped it).
    const restartPid = invs[restartIdx].pid;
    if (pidAlive(restartPid)) {
      return 'hung restart invocation pid ' + restartPid + ' is still alive - not killed';
    }
    // A fresh turn-2 session seeded from NEXT.md must follow.
    const after = invs.slice(restartIdx + 1).find(function (i) { return isFresh(i.argv); });
    if (!after) {
      return 'no fresh turn-2 session after killing the hung restart\nstderr: ' +
        r.stderr.slice(-500);
    }
    if (lastArg(after.argv) !== NEXT_CONTENT) {
      return 'turn-2 prompt is not the NEXT.md content.\n  got: ' + lastArg(after.argv);
    }
    if (sessionIdOf(after.argv) === sessionIdOf(invs[0].argv)) {
      return 'turn-2 session id is not distinct from the work session';
    }
  } finally {
    if (invFile) reapPids(invFile);
  }
});

// ---------- Case 9: NON-VACUITY - the OLD await-first driveRestart HANGS ----------
// Reconstruct the buggy driveRestart (await runTurn FIRST, then poll). Run it in a
// tiny harness against the same hung mock. Because the mock never exits, the awaited
// runTurn never resolves, the poll loop never runs, and the harness must HANG until
// our bounded timeout fires. We capture that timeout as the non-vacuity proof: the
// fixed monitor-and-kill design passes Case 8 where this OLD design times out.
check('NON-VACUITY: OLD await-runTurn-first driveRestart HANGS against a hung restart', function () {
  const scratch = makeScratch();
  const companyDir = path.join(scratch, '.company');
  const projectsDir = path.join(scratch, 'projects');
  const { mockPath, invFile } =
    writeMockClaude(scratch, companyDir, projectsDir, 'restart', [600]);

  // A harness embedding the OLD driveRestart: await the restart invocation to EXIT
  // first, THEN poll for markers. No monitor-and-kill, no detached group.
  const oldHarness = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawn } = require('node:child_process');",
    'const companyDir = process.env.COMPANY_DIR;',
    "const debateConfirmedPath = path.join(companyDir, 'RESTART_DEBATE_CONFIRMED');",
    "const nextMdPath = path.join(companyDir, 'NEXT.md');",
    'const claudeBin = process.env.CLAUDE_BIN;',
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }',
    'function oldRunTurn(){',
    '  return new Promise(function(resolve){',
    "    const c = spawn(claudeBin, ['-p', '--resume', 'sid', '/company restart'],",
    "      { cwd: process.cwd(), env: Object.assign({}, process.env, { COMPANY_DIR: companyDir }), stdio: ['ignore','pipe','pipe'] });",
    '    c.stdout.on("data", function(){});',
    '    c.stderr.on("data", function(){});',
    '    c.on("exit", function(code){ resolve(code); });',
    '  });',
    '}',
    'async function oldDriveRestart(){',
    '  const restartStart = Date.now();',
    '  try { fs.unlinkSync(debateConfirmedPath); } catch(e){}',
    '  await oldRunTurn();', // HANGS here forever: the mock never exits.
    '  const deadline = restartStart + 30000;',
    '  while (Date.now() < deadline) {',
    '    if (fs.existsSync(debateConfirmedPath)) {',
    '      try { if (fs.statSync(nextMdPath).mtimeMs > restartStart) { console.log("REACHED_POLL"); process.exit(0); } } catch(e){}',
    '    }',
    '    await sleep(500);',
    '  }',
    '  process.exit(0);',
    '}',
    'oldDriveRestart();',
  ].join('\n');

  const harnessPath = path.join(scratch, 'old-harness.js');
  fs.writeFileSync(harnessPath, oldHarness);

  let res;
  try {
    res = spawnSync(process.execPath, [harnessPath], {
      cwd: scratch,
      env: Object.assign({}, process.env, {
        CLAUDE_BIN: mockPath,
        COMPANY_DIR: companyDir,
        __MOCK_RESTART_HANGS: '1',
      }),
      encoding: 'utf8',
      timeout: 6000,
      killSignal: 'SIGKILL',
    });
  } finally {
    reapPids(invFile);
  }

  const harnessTimedOut = res.error && res.error.code === 'ETIMEDOUT';
  if (!harnessTimedOut) {
    return 'OLD await-first driveRestart did NOT hang (exited code=' + res.status +
      ', stdout=' + JSON.stringify((res.stdout || '').trim()) + '). The mock should ' +
      'have made it hang on the awaited runTurn - test would be vacuous.';
  }
  if ((res.stdout || '').indexOf('REACHED_POLL') !== -1) {
    return 'OLD driveRestart reached the poll loop - it should never get past the await';
  }

  process.stderr.write(
    '[autoloop.test] NON-VACUITY: the OLD await-runTurn-first driveRestart HUNG ' +
    'against a hung restart mock (bounded 6000ms harness timeout fired, never logged ' +
    'REACHED_POLL - the awaited restart invocation never exited so the marker poll ' +
    'loop was unreachable). The fixed monitor-and-kill driveRestart passes Case 8 on ' +
    'the SAME hung mock. The async-spawn-and-kill path is load-bearing.\n'
  );
});

// ---------- Case 10: HUNG work turn is killed by the wall-clock backstop ----------
// The real bug: a work turn `claude -p` writes partial state then NEVER exits, and
// the main loop awaits runTurn forever (a 9-minute real run with --turn-timeout-secs
// 300 was never killed). The fix: runTurn starts a wall-clock timer on spawn, and on
// fire it KILLS the detached process group and RESOLVES a timed-out result so the
// loop proceeds to the fill check on the partial transcript. The mock catches
// SIGTERM, so the kill must escalate to SIGKILL. With a 3s backstop and fill stepped
// 300->600 the first hung turn is killed, fill is read (0.30), the second hung turn
// is killed and fill crosses (0.60), then a restart is driven. We assert: a work pid
// is GONE after the backstop, fill was computed (the loop did not hang), and progress
// was made past the first turn.
check('HUNG work turn: turn-timeout backstop kills the hung work child, loop proceeds', function () {
  let invFile;
  try {
    const r = runSupervisor({
      mode: 'restart',
      tokensByCall: [300, 600],
      maxTurns: 3,
      turnTimeoutSecs: 3,
      extraEnv: { __MOCK_WORK_HANGS: '1' },
      timeout: 30000,
    });
    invFile = r.invFile;
    if (r.timedOut) {
      return 'supervisor TIMED OUT against a hung work turn - the backstop never fired ' +
        '(runTurn awaited the forever-hanging child)\nstderr: ' + r.stderr.slice(-600);
    }
    const invs = readInvocations(r.invFile);
    if (invs.length < 1) {
      return 'no work invocation recorded\nstderr: ' + r.stderr.slice(-400);
    }
    // The first hung work child pid must be GONE (the backstop killed its group).
    const firstWorkPid = invs[0].pid;
    if (pidAlive(firstWorkPid)) {
      return 'hung work child pid ' + firstWorkPid + ' still alive - backstop did not kill it';
    }
    // The loop must have logged the backstop firing and then computed fill (proof it
    // proceeded past the hung turn rather than stalling forever).
    if (r.stderr.indexOf('backstop') === -1) {
      return 'no backstop log line - the timeout path did not fire\nstderr: ' + r.stderr.slice(-600);
    }
    if (r.stderr.indexOf('fill=') === -1) {
      return 'supervisor never computed fill after the hung turn (it stalled)\nstderr: ' +
        r.stderr.slice(-600);
    }
    // It must have run more than one turn (it did not stall on turn 1 forever).
    if (invs.length < 2) {
      return 'supervisor ran only ' + invs.length + ' invocation - it did not proceed ' +
        'past the first hung turn\nstderr: ' + r.stderr.slice(-600);
    }
  } finally {
    if (invFile) reapPids(invFile);
  }
});

// ---------- Case 11: NON-VACUITY - a runTurn WITHOUT the timeout-kill HANGS ----------
// Reconstruct the buggy runTurn (no wall-clock kill: it ONLY awaits the child's
// natural exit) inside a tiny supervisor variant. Run it against the same hung-work
// mock with a bounded harness timeout. Because the mock never exits, the awaited
// runTurn never resolves and the variant HANGS until our bounded timeout fires. We
// capture that timeout as the non-vacuity proof: the fixed runTurn passes Case 10
// where this no-timeout-kill design times out on the SAME hung work mock.
check('NON-VACUITY: a runTurn WITHOUT the timeout-kill HANGS against a hung work turn', function () {
  const scratch = makeScratch();
  const companyDir = path.join(scratch, '.company');
  const projectsDir = path.join(scratch, 'projects');
  const { mockPath, invFile } =
    writeMockClaude(scratch, companyDir, projectsDir, 'restart', [300]);

  // A minimal supervisor whose runTurn has NO wall-clock backstop: it spawns the
  // work child and ONLY awaits its natural exit (the original bug). One work turn
  // against the hung mock makes it hang forever.
  const noKillVariant = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawn } = require('node:child_process');",
    'const companyDir = process.env.COMPANY_DIR;',
    'const claudeBin = process.env.CLAUDE_BIN;',
    'const sessionId = "novac-work-sid";',
    '// BUGGY runTurn: spawn the work child, await ONLY its natural exit. No timer,',
    '// no group kill. A hung child makes this Promise never resolve.',
    'function runTurnNoKill() {',
    '  return new Promise(function (resolve) {',
    "    const c = spawn(claudeBin, ['-p', '--session-id', sessionId, 'do-work'],",
    "      { cwd: process.cwd(), env: Object.assign({}, process.env, { COMPANY_DIR: companyDir }),",
    "        stdio: ['ignore','pipe','pipe'], detached: true });",
    '    c.stdout.on("data", function(){});',
    '    c.stderr.on("data", function(){});',
    '    c.on("exit", function(code){ resolve(code); });',
    '  });',
    '}',
    'async function main() {',
    '  await runTurnNoKill();', // HANGS here forever: the mock never exits.
    '  console.log("REACHED_AFTER_TURN");',
    '  process.exit(0);',
    '}',
    'main();',
  ].join('\n');

  const variantPath = path.join(scratch, 'supervisor-nokill.js');
  fs.writeFileSync(variantPath, noKillVariant);

  let res;
  try {
    res = spawnSync(process.execPath, [variantPath], {
      cwd: scratch,
      env: Object.assign({}, process.env, {
        CLAUDE_BIN: mockPath,
        COMPANY_DIR: companyDir,
        __MOCK_WORK_HANGS: '1',
      }),
      encoding: 'utf8',
      timeout: 6000,
      killSignal: 'SIGKILL',
    });
  } finally {
    reapPids(invFile);
  }

  const harnessTimedOut = res.error && res.error.code === 'ETIMEDOUT';
  if (!harnessTimedOut) {
    return 'the no-timeout-kill runTurn did NOT hang (exited code=' + res.status +
      ', stdout=' + JSON.stringify((res.stdout || '').trim()) + '). The hung-work mock ' +
      'should have made it hang on the awaited child - test would be vacuous.';
  }
  if ((res.stdout || '').indexOf('REACHED_AFTER_TURN') !== -1) {
    return 'no-timeout-kill runTurn proceeded past the turn - it should never resolve ' +
      'against a forever-hanging child';
  }

  process.stderr.write(
    '[autoloop.test] NON-VACUITY: a runTurn WITHOUT the wall-clock timeout-kill HUNG ' +
    'against a hung-work mock (bounded 6000ms harness timeout fired, never logged ' +
    'REACHED_AFTER_TURN - the awaited work child never exited so the loop could never ' +
    'proceed). The fixed runTurn (start a timer on spawn, kill the detached group on ' +
    'fire, resolve a timed-out result) passes Case 10 on the SAME hung mock. The ' +
    'wall-clock backstop kill is load-bearing.\n'
  );
});

// ---------- Case 12: a HUNG work turn OVER threshold drives a RESTART, not an error ----------
// The real9 bug: a turn killed by the wall-clock backstop was classified as an ERROR
// (error streak, resume the same session) instead of a normal turn end. The fix makes
// runTurn flag the kill as timedOut, and the main loop routes a timed-out turn to the
// SAME post-turn handling a natural exit gets: check done, compute fill, and if fill is
// over threshold DRIVE /company restart. Here a SINGLE work turn writes a usage block
// that puts fill at 0.60 (over the 0.50 threshold) then HANGS FOREVER. With a 3s
// backstop the turn is killed. We assert the supervisor did NOT increment the error
// streak, computed fill over threshold, DROVE /company restart, and then seeded a fresh
// session from NEXT.md. I.e. a hung work turn leads to an auto-RESTART, not an error-retry.
check('HUNG work turn over threshold drives a restart (no error streak, fresh session from NEXT.md)', function () {
  let invFile;
  try {
    const r = runSupervisor({
      mode: 'restart',
      tokensByCall: [600],
      maxTurns: 2,
      turnTimeoutSecs: 3,
      extraEnv: { __MOCK_WORK_HANGS: '1' },
      timeout: 45000,
    });
    invFile = r.invFile;
    if (r.timedOut) {
      return 'supervisor TIMED OUT - the backstop never fired\nstderr: ' + r.stderr.slice(-600);
    }
    // A timed-out turn must NOT be counted as an error.
    if (/error streak \d+\/\d+/.test(r.stderr)) {
      return 'a timed-out work turn was counted toward the error streak (it must not be)\nstderr: ' +
        r.stderr.slice(-700);
    }
    // The backstop must have fired and fill must have been computed over threshold.
    if (r.stderr.indexOf('backstop') === -1) {
      return 'no backstop log - the timeout path did not fire\nstderr: ' + r.stderr.slice(-600);
    }
    if (r.stderr.indexOf('fill >= threshold') === -1) {
      return 'supervisor did not see fill over threshold after the hung turn\nstderr: ' +
        r.stderr.slice(-700);
    }
    const invs = readInvocations(r.invFile);
    // The supervisor must have DRIVEN /company restart on the work session.
    const restartIdx = invs.findIndex(function (i) { return isRestartDrive(i.argv); });
    if (restartIdx === -1) {
      return 'supervisor never drove /company restart after the hung over-threshold turn\nstderr: ' +
        r.stderr.slice(-700);
    }
    const workSession = sessionIdOf(invs[0].argv);
    if (sessionIdOf(invs[restartIdx].argv) !== workSession) {
      return 'restart drive ran on a different session than the hung work turn';
    }
    // After the restart there must be a NEW fresh session seeded from NEXT.md.
    const after = invs.slice(restartIdx + 1).find(function (i) { return isFresh(i.argv); });
    if (!after) return 'no fresh session launched after the restart drive';
    if (lastArg(after.argv) !== NEXT_CONTENT) {
      return 'post-restart prompt is not NEXT.md\n  got: ' + lastArg(after.argv);
    }
    if (sessionIdOf(after.argv) === workSession) {
      return 'post-restart session id is NOT distinct from the hung work session';
    }
  } finally {
    if (invFile) reapPids(invFile);
  }
});

// ---------- Case 13: NON-VACUITY - error-classifying a timeout never restarts ----------
// Build a mutant supervisor whose main loop DROPS the timedOut->fill routing, so a
// timed-out turn falls into the error-streak path (resume the same session) just like
// the pre-fix real9 behavior. Run it against the SAME hung-over-threshold mock as Case
// 12. The mutant never reaches computeFill on the timed-out turn, so it NEVER drives
// /company restart and NEVER seeds a fresh session. Case 12's restart assertion FAILS
// against this mutant. That is the bar: the fix routes a timed-out turn to the fill path,
// the mutant routes it to error-retry. We capture the failure verbatim as the proof.
check('NON-VACUITY: a main loop that error-classifies a timeout never restarts a hung turn', function () {
  const scratch = makeScratch();
  const companyDir = path.join(scratch, '.company');
  const projectsDir = path.join(scratch, 'projects');
  const { mockPath, binDir, invFile } =
    writeMockClaude(scratch, companyDir, projectsDir, 'restart', [600]);

  // Mutate the real supervisor: disable the timedOut branch so a timed-out turn falls
  // through to the `code !== 0` error-streak path (the pre-fix real9 misclassification).
  const src = fs.readFileSync(SUPERVISOR, 'utf8');
  const NEEDLE = 'if (turnResult.timedOut) {';
  if (src.indexOf(NEEDLE) === -1) {
    return 'could not find the timedOut branch to mutate (test needs updating)';
  }
  const mutated = src.replace(NEEDLE, 'if (false && turnResult.timedOut) {');
  const mutantPath = path.join(scratch, 'supervisor-error-classify.js');
  fs.writeFileSync(mutantPath, mutated);

  let r;
  try {
    r = runSupervisor({
      scratch: scratch,
      companyDir: companyDir,
      projectsDir: projectsDir,
      supervisorPath: mutantPath,
      mode: 'restart',
      tokensByCall: [600],
      maxTurns: 4,
      turnTimeoutSecs: 3,
      extraEnv: { __MOCK_WORK_HANGS: '1' },
      timeout: 30000,
    });
  } finally {
    reapPids(invFile);
  }
  if (r.timedOut) {
    return 'mutant supervisor TIMED OUT (expected it to error-retry, not hang)\nstderr: ' +
      r.stderr.slice(-600);
  }
  const invs = readInvocations(r.invFile);
  const droveRestart = invs.some(function (i) { return isRestartDrive(i.argv); });
  if (droveRestart) {
    return 'the error-classifying mutant DROVE /company restart - it should have error-retried ' +
      'the same session and never restarted (test would be vacuous)';
  }
  // It must have counted the timed-out turn as an error instead.
  if (!/error streak \d+\/\d+/.test(r.stderr)) {
    return 'the mutant did not error-classify the timed-out turn (no error streak logged)\nstderr: ' +
      r.stderr.slice(-600);
  }
  process.stderr.write(
    '[autoloop.test] NON-VACUITY: a main loop that error-classifies a timed-out work turn ' +
    '(timedOut branch disabled, real9 behavior) NEVER drove /company restart against a hung ' +
    'over-threshold mock - it counted the kill as an error and resumed the same session ' +
    '(error streak logged). Case 12 (hung over-threshold turn DRIVES a restart) FAILS against ' +
    'this mutant. Routing a timed-out turn to the fill->restart path is load-bearing.\n'
  );
});

// ---------- summary ----------
if (failures > 0) {
  console.log('AUTOLOOP TESTS FAILED: ' + failures + ' of ' + caseNo);
  process.exit(1);
}
console.log('ALL AUTOLOOP TESTS PASSED (' + caseNo + ' checks)');
