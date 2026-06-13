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
    'test-goal',
  ];

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

// ---------- summary ----------
if (failures > 0) {
  console.log('AUTOLOOP TESTS FAILED: ' + failures + ' of ' + caseNo);
  process.exit(1);
}
console.log('ALL AUTOLOOP TESTS PASSED (' + caseNo + ' checks)');
