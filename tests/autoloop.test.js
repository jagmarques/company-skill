#!/usr/bin/env node
// tests/autoloop.test.js
// Non-vacuous test for scripts/company-autoloop.js (monitor-and-kill design).
//
// The supervisor mimics a human running /clear: it POLLS the .company markers
// WHILE the detached child runs, then KILLS the whole child process group the
// moment it sees done/restart/cancel, and relaunches fresh. The mock claude
// here simulates a STUCK mid-goal session: it writes the markers and then SLEEPS
// indefinitely WITHOUT exiting. A correct supervisor must detect, kill, relaunch.
//
// criteria.json uses the REAL /company schema: an object with a criteria array
// whose entries carry a passes boolean. The done check reads passes === true.
//
// Asserts:
//   - Restart: stuck mock (writes NEXT.md + RESTART_DEBATE_CONFIRMED, then sleeps)
//     is DETECTED, KILLED (its pid is gone), and a SECOND cycle launches with a
//     DISTINCT fresh session id whose prompt is seeded from NEXT.md.
//   - Done: stuck mock writing all-pass real-schema criteria.json is detected,
//     killed, exit 0.
//   - CANCEL: mock touches CANCEL then sleeps -> killed, exit 0.
//   - Two DISTINCT --session-id values across cycles (fresh per cycle).
//   - NO invocation passed --continue or --resume (regression guard).
//   - max-cycles cap exits non-zero.
//   - passes:false object does NOT count as done.
//
// Non-vacuity proof (recorded verbatim in findings):
//   - The monitor-and-kill restart test HANGS against a spawnSync-wait version of
//     the supervisor: that old design waits for the stuck mock to exit naturally,
//     which it never does, so cycle 2 is never reached. We run the old design with
//     a bounded timeout and assert it times out (never reaches the second cycle).
//     The fixed design kills the stuck mock and reaches cycle 2. A test the new
//     design passes and the old design provably hangs is the non-vacuity bar.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'company-autoloop.js');
const NEXT_CONTENT = 'CONTINUATION_PROMPT_FROM_CYCLE_1';

let failures = 0;
let caseNo = 0;
const spawnedPids = [];

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

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// Write a STUCK mock claude binary to scratch/bin/claude.
// The mock records its own pid + argv per invocation (one JSON line in invFile),
// writes the requested markers, then SLEEPS via setInterval WITHOUT exiting -
// simulating a real mid-goal session that the stop-guard will not let exit.
//   mode 'restart': call 1 writes NEXT.md + RESTART_DEBATE_CONFIRMED then sleeps;
//                   call 2+ writes all-pass criteria.json then sleeps.
//   mode 'done':    every call writes all-pass criteria.json then sleeps.
//   mode 'cancel':  every call touches CANCEL then sleeps.
// Every mock sleeps so the ONLY way the supervisor advances is by killing it.
function writeMockClaude(invFile, companyDir, mode) {
  const binDir = path.join(path.dirname(invFile), 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mockPath = path.join(binDir, 'claude');

  const passEnvGate = "process.env.AUTOLOOP_TEST_PASSES === 'false' ? false : true";

  const mockSrc = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const invFile = ' + JSON.stringify(invFile) + ';',
    'const companyDir = process.env.COMPANY_DIR || ' + JSON.stringify(companyDir) + ';',
    'const nextContent = ' + JSON.stringify(NEXT_CONTENT) + ';',
    'const mode = ' + JSON.stringify(mode) + ';',
    'const record = { pid: process.pid, argv: process.argv.slice(2) };',
    "fs.appendFileSync(invFile, JSON.stringify(record) + '\\n');",
    "const lines = fs.readFileSync(invFile, 'utf8').trim().split('\\n').filter(Boolean);",
    'const callNo = lines.length;',
    'fs.mkdirSync(companyDir, { recursive: true });',
    'function writeDone() {',
    '  const passVal = ' + passEnvGate + ';',
    "  const criteria = { goal: 't', criteria: [{ id: 1, passes: passVal, evidence: 'x', stakes: 'normal' }] };",
    "  fs.writeFileSync(path.join(companyDir, 'criteria.json'), JSON.stringify(criteria));",
    '}',
    'function writeRestart() {',
    // NEXT.md first so its mtime is fresh, busy-wait, then the confirmed marker.
    "  fs.writeFileSync(path.join(companyDir, 'NEXT.md'), nextContent);",
    '  const s = Date.now(); while (Date.now() - s < 30) {}',
    "  fs.writeFileSync(path.join(companyDir, 'RESTART_DEBATE_CONFIRMED'), JSON.stringify({ sessionId: 'mock' }));",
    '}',
    "if (mode === 'cancel') {",
    "  fs.writeFileSync(path.join(companyDir, 'CANCEL'), '');",
    "} else if (mode === 'done') {",
    '  writeDone();',
    '} else {',
    // restart mode: first call restarts, later calls complete.
    '  if (callNo === 1) writeRestart(); else writeDone();',
    '}',
    // STUCK: never exit on our own. The supervisor must kill this process group.
    'setInterval(function () {}, 1000);',
  ].join('\n');

  fs.writeFileSync(mockPath, mockSrc, { mode: 0o755 });
  return { mockPath, binDir };
}

// Run the supervisor against the mock claude.
// opts.mode selects mock behavior (default 'restart').
// opts.maxCycles overrides the default (10).
// opts.supervisorPath uses an alternative supervisor (for mutation testing).
// opts.preSetup(companyDir) runs before the supervisor (e.g. to write CANCEL).
// opts.timeout caps the outer spawnSync so a hanging supervisor is observable.
function runSupervisor(opts) {
  opts = opts || {};
  const scratch = opts.scratch || makeScratch();
  const companyDir = opts.companyDir || path.join(scratch, '.company');
  const invFile = path.join(scratch, 'invocations.ndjson');
  const mode = opts.mode || 'restart';
  const { mockPath, binDir } = writeMockClaude(invFile, companyDir, mode);
  const supervisorPath = opts.supervisorPath || SUPERVISOR;

  if (opts.preSetup) opts.preSetup(companyDir);

  const args = [
    supervisorPath,
    '--company-dir', companyDir,
    '--project-dir', scratch,
    '--max-cycles', String(opts.maxCycles !== undefined ? opts.maxCycles : 10),
    '--permission-mode', 'bypassPermissions',
    // Short cycle timeout keeps CI fast if a kill path ever regresses.
    '--cycle-timeout-secs', String(opts.cycleTimeoutSecs !== undefined ? opts.cycleTimeoutSecs : 20),
    'test-goal',
  ];

  const env = Object.assign({}, process.env, {
    CLAUDE_BIN: mockPath,
    COMPANY_DIR: companyDir,
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

function getSessionId(argv) {
  const i = argv.indexOf('--session-id');
  return i >= 0 ? argv[i + 1] : null;
}

// Track every mock pid so the finally block can reap any stray sleeper.
function trackPids(invs) {
  for (let i = 0; i < invs.length; i++) {
    if (invs[i].pid) spawnedPids.push(invs[i].pid);
  }
}

try {
  // ---------- Case 1: restart - detect, KILL stuck mock, relaunch cycle 2 ----------
  // Core new assertion. The mock writes restart markers then sleeps forever.
  // The supervisor must kill it (pid gone) and launch a SECOND cycle.
  check('CORE monitor-and-kill: stuck restart mock is killed, cycle 2 launches', function () {
    const r = runSupervisor({ mode: 'restart', maxCycles: 2 });
    const invs = readInvocations(r.invFile);
    trackPids(invs);
    if (invs.length < 2) {
      return 'expected >= 2 invocations (cycle 2 must launch), got ' + invs.length +
             '\nstderr: ' + r.stderr.slice(-400);
    }
    // The first (stuck) mock pid must be dead - the supervisor killed its group.
    const firstPid = invs[0].pid;
    if (pidAlive(firstPid)) {
      return 'first stuck mock pid ' + firstPid + ' still alive - supervisor did not kill it';
    }
    // Cycle 2 prompt must be seeded from NEXT.md.
    const secondArgv = invs[1].argv;
    const prompt2 = secondArgv[secondArgv.length - 1];
    if (prompt2 !== NEXT_CONTENT) {
      return 'cycle-2 prompt mismatch.\n  got:      ' + prompt2 + '\n  expected: ' + NEXT_CONTENT;
    }
    // Distinct fresh session ids across cycles.
    const ids = invs.map(function (inv) { return getSessionId(inv.argv); });
    if (ids.some(function (id) { return !id; })) {
      return 'some invocation missing --session-id: ' + JSON.stringify(ids);
    }
    if (new Set(ids).size < 2) {
      return 'session ids are NOT distinct: ' + JSON.stringify(ids);
    }
  });

  // ---------- Case 2: no --continue or --resume regression ----------
  check('no invocation passed --continue or --resume', function () {
    const r = runSupervisor({ mode: 'restart', maxCycles: 2 });
    const invs = readInvocations(r.invFile);
    trackPids(invs);
    for (let i = 0; i < invs.length; i++) {
      const argv = invs[i].argv;
      if (argv.indexOf('--continue') !== -1) {
        return 'invocation ' + (i + 1) + ' passed --continue (regression)';
      }
      if (argv.indexOf('--resume') !== -1) {
        return 'invocation ' + (i + 1) + ' passed --resume (regression)';
      }
    }
  });

  // ---------- Case 3: done - stuck mock with all-pass criteria -> kill + exit 0 ----------
  check('stuck done mock: detected, killed, exit 0', function () {
    const r = runSupervisor({ mode: 'done', maxCycles: 3 });
    const invs = readInvocations(r.invFile);
    trackPids(invs);
    if (r.code !== 0) {
      return 'expected exit 0 on done, got ' + r.code + '\nstderr: ' + r.stderr.slice(-400);
    }
    if (invs.length < 1) return 'expected >= 1 invocation, got 0';
    if (pidAlive(invs[0].pid)) {
      return 'done mock pid ' + invs[0].pid + ' still alive - supervisor did not kill it';
    }
  });

  // ---------- Case 4: CANCEL - stuck mock touches CANCEL then sleeps -> kill + exit 0 ----------
  check('stuck cancel mock: killed, exit 0, CANCEL logged', function () {
    const r = runSupervisor({ mode: 'cancel', maxCycles: 3 });
    const invs = readInvocations(r.invFile);
    trackPids(invs);
    if (r.code !== 0) {
      return 'expected exit 0 on CANCEL, got ' + r.code + '\nstderr: ' + r.stderr.slice(-400);
    }
    if (r.stderr.indexOf('CANCEL') === -1) {
      return 'expected CANCEL mention in log, got: ' + r.stderr.slice(-300);
    }
    if (invs.length >= 1 && pidAlive(invs[0].pid)) {
      return 'cancel mock pid ' + invs[0].pid + ' still alive - supervisor did not kill it';
    }
  });

  // ---------- Case 5: max-cycles cap exits non-zero ----------
  // max-cycles=1: cycle 1 is a restart, then the for-loop cap fires -> exit 3.
  check('max-cycles cap exits non-zero after cap', function () {
    const r = runSupervisor({ mode: 'restart', maxCycles: 1 });
    trackPids(readInvocations(r.invFile));
    if (r.code === 0) {
      return 'expected non-zero exit with max-cycles=1 on restart-only first cycle, got 0';
    }
  });

  // ---------- Case 6: passes:false is NOT done ----------
  check('passes:false criteria object does not count as done', function () {
    const r = runSupervisor({ mode: 'done', maxCycles: 2, extraEnv: { AUTOLOOP_TEST_PASSES: 'false' } });
    trackPids(readInvocations(r.invFile));
    if (r.code === 0) {
      return 'supervisor exited 0 with passes:false criteria (false positive done)';
    }
    if (r.stderr.indexOf('goal DONE') !== -1) {
      return 'supervisor logged goal DONE for passes:false criteria';
    }
  });

  // ---------- Case 7: NON-VACUITY - spawnSync-wait design HANGS on the stuck mock ----------
  // Mutate the supervisor back to a spawnSync-wait design: it waits for the child
  // to exit naturally before checking markers. Against a mock that NEVER exits,
  // it can never reach cycle 2. With a bounded outer timeout the old design times
  // out (never reaches the second invocation), proving the kill is load-bearing.
  check('NON-VACUITY: spawnSync-wait supervisor hangs on stuck mock (never reaches cycle 2)', function () {
    const src = fs.readFileSync(SUPERVISOR, 'utf8');

    // Build a minimal spawnSync-wait variant that mirrors the OLD behavior: it
    // blocks on spawnSync until the child exits, THEN classifies markers. It does
    // not spawn detached, does not poll, never kills. This is the architecture the
    // 1% test found broken.
    const oldSupervisor = [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { randomUUID } = require('node:crypto');",
      "const { spawnSync } = require('node:child_process');",
      'const argv = process.argv.slice(2);',
      'function argValue(f){const i=argv.indexOf(f);return i>=0&&argv[i+1]?argv[i+1]:null;}',
      "const projectDir = path.resolve(argValue('--project-dir')||process.cwd());",
      "const companyDir = path.resolve(process.env.COMPANY_DIR||argValue('--company-dir')||path.join(projectDir,'.company'));",
      "const maxCycles = parseInt(argValue('--max-cycles')||'50',10);",
      "const permissionMode = argValue('--permission-mode')||'bypassPermissions';",
      "const claudeBin = process.env.CLAUDE_BIN||'claude';",
      'let currentPrompt = argv[argv.length-1];',
      "const criteriaPath = path.join(companyDir,'criteria.json');",
      "const debateConfirmedPath = path.join(companyDir,'RESTART_DEBATE_CONFIRMED');",
      "const nextMdPath = path.join(companyDir,'NEXT.md');",
      'for (let cycle=1; cycle<=maxCycles; cycle++){',
      '  const sessionId = randomUUID();',
      '  const loopStart = Date.now();',
      '  try { fs.unlinkSync(debateConfirmedPath); } catch(e){}',
      // The fatal line: spawnSync BLOCKS until the child exits. The stuck mock
      // never exits, so we never get past here. No poll, no kill.
      "  spawnSync(claudeBin, ['-p','--session-id',sessionId,'--permission-mode',permissionMode,currentPrompt], { cwd: projectDir, env: Object.assign({},process.env,{COMPANY_DIR:companyDir}), encoding:'utf8', maxBuffer: 10*1024*1024 });",
      '  if (fs.existsSync(path.join(companyDir,"CANCEL"))) process.exit(0);',
      '  try { const p=JSON.parse(fs.readFileSync(criteriaPath,"utf8")); const l=Array.isArray(p.criteria)?p.criteria:(Array.isArray(p)?p:[]); if(l.length&&l.every(c=>c&&c.passes===true)) process.exit(0);} catch(e){}',
      '  try { if(fs.existsSync(debateConfirmedPath)&&fs.statSync(nextMdPath).mtimeMs>loopStart){ currentPrompt=fs.readFileSync(nextMdPath,"utf8").trim(); continue; } } catch(e){}',
      '  process.exit(2);',
      '}',
      'process.exit(3);',
    ].join('\n');

    const scratch = makeScratch();
    const oldPath = path.join(scratch, 'supervisor-spawnsync.js');
    fs.writeFileSync(oldPath, oldSupervisor);

    // Bounded timeout so the hang is observable, not infinite.
    const r = runSupervisor({
      scratch: scratch,
      supervisorPath: oldPath,
      mode: 'restart',
      maxCycles: 2,
      timeout: 6000,
    });
    const invs = readInvocations(r.invFile);
    trackPids(invs);

    // The old design must NOT reach cycle 2: it blocks in cycle 1's spawnSync on
    // the stuck mock. It either times out or only ever recorded ONE invocation.
    if (invs.length >= 2) {
      return 'spawnSync-wait design unexpectedly reached cycle 2 (' + invs.length +
             ' invocations) - the mock was not actually stuck, test is vacuous';
    }
    if (!r.timedOut) {
      return 'spawnSync-wait design did not hang (timedOut=' + r.timedOut +
             ', code=' + r.code + ') - expected it to block on the stuck mock';
    }

    process.stderr.write(
      '[autoloop.test] NON-VACUITY: spawnSync-wait supervisor HUNG on the stuck mock ' +
      '(timedOut=' + r.timedOut + ', invocations=' + invs.length + ', never reached cycle 2). ' +
      'The fixed monitor-and-kill design kills the stuck mock and reaches cycle 2. ' +
      'The kill path is load-bearing.\n'
    );
  });
} finally {
  // Reap any stray mock sleeper so CI never leaks a setInterval process.
  for (let i = 0; i < spawnedPids.length; i++) {
    try { process.kill(spawnedPids[i], 'SIGKILL'); } catch (e) {}
  }
}

// ---------- summary ----------
if (failures > 0) {
  console.log('AUTOLOOP TESTS FAILED: ' + failures + ' of ' + caseNo);
  process.exit(1);
}
console.log('ALL AUTOLOOP TESTS PASSED (' + caseNo + ' checks)');
