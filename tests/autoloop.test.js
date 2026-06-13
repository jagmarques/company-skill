#!/usr/bin/env node
// tests/autoloop.test.js
// Non-vacuous test for scripts/company-autoloop.js.
//
// Uses a mock `claude` binary written to a temp dir. The mock simulates:
//   cycle 1: writes NEXT.md + RESTART_DEBATE_CONFIRMED -> "restart"
//   cycle 2: writes all-passing criteria.json -> "done"
//
// criteria.json uses the REAL /company schema: an object with a criteria array
// whose entries carry a passes boolean. The done check reads passes === true.
//
// Asserts:
//   - Two DISTINCT --session-id values were used (fresh per cycle).
//   - Second invocation's prompt equals the NEXT.md content from cycle 1.
//   - Supervisor exited 0 (goal done) on the real object schema.
//   - A passes:false object does NOT count as done (supervisor does not early-exit).
//   - NO invocation passed --continue or --resume (regression guard).
//
// Non-vacuity proofs:
//   - A mutated supervisor that uses --continue instead of a fresh --session-id
//     invokes --continue, which case 4 would have caught.
//   - The real-schema done case fails against the old array-only/status logic
//     (it returns not-done for the object schema, so exit 0 never fires).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'company-autoloop.js');
const NEXT_CONTENT = 'CONTINUATION_PROMPT_FROM_CYCLE_1';

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

// Write the mock claude binary to scratch/bin/claude.
// The mock records each invocation's argv in invFile (one JSON line per call).
// Based on call number:
//   call 1: write NEXT.md + RESTART_DEBATE_CONFIRMED -> simulate "restart"
//   call 2+: write criteria.json (all pass) -> simulate "done"
// Returns { mockPath, binDir }.
function writeMockClaude(invFile, companyDir) {
  const binDir = path.join(path.dirname(invFile), 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mockPath = path.join(binDir, 'claude');

  const mockSrc = [
    "#!/usr/bin/env node",
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const invFile = " + JSON.stringify(invFile) + ";",
    "const companyDir = process.env.COMPANY_DIR || " + JSON.stringify(companyDir) + ";",
    "const nextContent = " + JSON.stringify(NEXT_CONTENT) + ";",
    "const record = { argv: process.argv.slice(2) };",
    "fs.appendFileSync(invFile, JSON.stringify(record) + '\\n');",
    "const lines = fs.readFileSync(invFile, 'utf8').trim().split('\\n').filter(Boolean);",
    "const callNo = lines.length;",
    "fs.mkdirSync(companyDir, { recursive: true });",
    "if (callNo === 1) {",
    // Write NEXT.md first so its mtime is set, then write debate confirmed.
    "  fs.writeFileSync(path.join(companyDir, 'NEXT.md'), nextContent);",
    // Small busy-wait so mtime is clearly after loop-start captured before spawn.
    "  const s = Date.now(); while (Date.now() - s < 30) {}",
    "  fs.writeFileSync(path.join(companyDir, 'RESTART_DEBATE_CONFIRMED'), JSON.stringify({ sessionId: 'mock' }));",
    "  process.exit(0);",
    "}",
    // Real schema: object with a criteria array, each entry has passes:boolean.
    // AUTOLOOP_TEST_PASSES=false makes the mock write a not-done object instead.
    "const passVal = process.env.AUTOLOOP_TEST_PASSES === 'false' ? false : true;",
    "const criteria = { goal: 't', criteria: [{ id: 1, passes: passVal, evidence: 'x', stakes: 'normal' }] };",
    "fs.writeFileSync(path.join(companyDir, 'criteria.json'), JSON.stringify(criteria));",
    "process.exit(0);",
  ].join('\n');

  fs.writeFileSync(mockPath, mockSrc, { mode: 0o755 });
  return { mockPath, binDir };
}

// Run the supervisor against the mock claude.
// opts.maxCycles overrides the default (10).
// opts.supervisorPath uses an alternative supervisor (for mutation testing).
// opts.preSetup(companyDir) runs before the supervisor (e.g. to write CANCEL).
function runSupervisor(opts) {
  opts = opts || {};
  const scratch = opts.scratch || makeScratch();
  const companyDir = opts.companyDir || path.join(scratch, '.company');
  const invFile = path.join(scratch, 'invocations.ndjson');
  const { mockPath, binDir } = writeMockClaude(invFile, companyDir);
  const supervisorPath = opts.supervisorPath || SUPERVISOR;

  if (opts.preSetup) opts.preSetup(companyDir);

  const args = [
    supervisorPath,
    '--company-dir', companyDir,
    '--project-dir', scratch,
    '--max-cycles', String(opts.maxCycles !== undefined ? opts.maxCycles : 10),
    '--permission-mode', 'bypassPermissions',
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
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    invFile: invFile,
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

// ---------- Case 1: happy path ----------
check('happy path: two cycles complete with exit 0', function () {
  const r = runSupervisor();
  if (r.code !== 0) return 'supervisor exited ' + r.code + '\nstderr: ' + r.stderr;
});

// ---------- Case 2: fresh session ids ----------
check('two distinct session ids used across cycles', function () {
  const r = runSupervisor();
  const invs = readInvocations(r.invFile);
  if (invs.length < 2) return 'expected >= 2 invocations, got ' + invs.length;
  const ids = invs.map(function (inv) { return getSessionId(inv.argv); });
  if (ids.some(function (id) { return !id; })) {
    return 'some invocation missing --session-id: ' + JSON.stringify(ids);
  }
  const unique = new Set(ids);
  if (unique.size < 2) return 'session ids are NOT distinct: ' + JSON.stringify(ids);
});

// ---------- Case 3: continuation prompt seeded from NEXT.md ----------
check('second invocation prompt equals NEXT.md from cycle 1', function () {
  const r = runSupervisor();
  const invs = readInvocations(r.invFile);
  if (invs.length < 2) return 'expected >= 2 invocations, got ' + invs.length;
  // The supervisor passes the prompt as the last positional arg.
  const secondArgv = invs[1].argv;
  const prompt = secondArgv[secondArgv.length - 1];
  if (prompt !== NEXT_CONTENT) {
    return 'cycle-2 prompt mismatch.\n  got:      ' + prompt +
           '\n  expected: ' + NEXT_CONTENT;
  }
});

// ---------- Case 4: no --continue or --resume regression ----------
check('no invocation passed --continue or --resume', function () {
  const r = runSupervisor();
  const invs = readInvocations(r.invFile);
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

// ---------- Case 5: CANCEL exits 0 ----------
check('CANCEL file causes exit 0', function () {
  const r = runSupervisor({
    preSetup: function (companyDir) {
      fs.mkdirSync(companyDir, { recursive: true });
      fs.writeFileSync(path.join(companyDir, 'CANCEL'), '');
    },
  });
  if (r.code !== 0) return 'expected exit 0 on CANCEL, got ' + r.code + '\nstderr: ' + r.stderr;
  if (r.stderr.indexOf('CANCEL') === -1) {
    return 'expected CANCEL mention in log, got: ' + r.stderr.slice(0, 300);
  }
});

// ---------- Case 6: max-cycles cap ----------
// With max-cycles=1: cycle 1 is a restart, then the for-loop cap fires -> exit 3.
check('max-cycles cap exits non-zero after cap', function () {
  const r = runSupervisor({ maxCycles: 1 });
  if (r.code === 0) {
    return 'expected non-zero exit with max-cycles=1 on restart-only first cycle, got 0';
  }
});

// ---------- Case: passes:false is NOT done ----------
// The mock writes a real-schema object whose entry is passes:false. The
// supervisor must never treat that as done. With max-cycles small it should
// exit non-zero (cap or error), never exit 0 via the goal-done path.
check('passes:false criteria object does not count as done', function () {
  const r = runSupervisor({ maxCycles: 3, extraEnv: { AUTOLOOP_TEST_PASSES: 'false' } });
  if (r.code === 0) {
    return 'supervisor exited 0 with passes:false criteria (false positive done)';
  }
  if (r.stderr.indexOf('goal DONE') !== -1) {
    return 'supervisor logged goal DONE for passes:false criteria';
  }
});

// ---------- Case 7: non-vacuity mutation proof ----------
// Replace the fresh-session spawn block with --continue. Confirm the mutated
// supervisor actually passes --continue to the mock (proving case 4 catches it).
check('NON-VACUITY: mutated supervisor using --continue invokes --continue', function () {
  const src = fs.readFileSync(SUPERVISOR, 'utf8');

  // Targeted replacement: swap out the two fresh-session lines for --continue.
  const mutated = src.replace(
    "'-p',\n      '--session-id', sessionId,",
    "'-p',\n      '--continue',"
  );
  if (mutated === src) {
    return 'mutation target not found in supervisor source - update this test';
  }

  const scratch = makeScratch();
  const mutatedPath = path.join(scratch, 'supervisor-mutated.js');
  fs.writeFileSync(mutatedPath, mutated);

  const r = runSupervisor({ scratch: scratch, supervisorPath: mutatedPath });

  const invs = readInvocations(r.invFile);
  let foundContinue = false;
  for (let i = 0; i < invs.length; i++) {
    if (invs[i].argv.indexOf('--continue') !== -1) { foundContinue = true; break; }
  }
  if (!foundContinue) {
    return 'mutation did not produce --continue invocations - verify mutation target';
  }

  // Confirm: no distinct session ids exist (the regression IS present).
  const ids = invs.map(function (inv) { return getSessionId(inv.argv); }).filter(Boolean);
  if (new Set(ids).size >= 2) {
    return 'mutation still produced distinct session ids - mutation was ineffective';
  }

  // Print evidence for findings.
  process.stderr.write(
    '[autoloop.test] NON-VACUITY: mutated supervisor invoked --continue ' +
    invs.length + ' time(s), 0 distinct session-ids.' +
    ' Case 4 (no --continue) would FAIL against this mutant.\n'
  );
  // The case PASSES because we confirmed the mutation behaves as expected
  // (the regression is detectable).
});

// ---------- Case: real-schema done is NON-VACUOUS vs old array/status logic ----------
// Mutate isGoalDone back to the pre-fix array-only + status logic. Against the
// real object schema {criteria:[{passes:true}]} that old code returns not-done,
// so the supervisor never exits 0 via done and hits the max-cycles cap instead.
// This proves the happy-path "exits 0 on done" assertion is non-vacuous.
check('NON-VACUITY: old array/status isGoalDone fails the real object schema', function () {
  const src = fs.readFileSync(SUPERVISOR, 'utf8');

  const oldBody = [
    "  try {",
    "    const raw = fs.readFileSync(criteriaPath, 'utf8');",
    "    const list = JSON.parse(raw);",
    "    if (!Array.isArray(list) || list.length === 0) return false;",
    "    return list.every(function (c) {",
    "      const s = (c.status || '').toLowerCase();",
    "      return s === 'done' || s === 'pass';",
    "    });",
    "  } catch (e) {",
    "    return false;",
    "  }",
  ].join('\n');

  const fnStart = src.indexOf('function isGoalDone() {');
  if (fnStart === -1) return 'isGoalDone not found in supervisor source';
  const bodyStart = src.indexOf('{', fnStart) + 1;
  // Find the matching closing brace for the function body.
  let depth = 1;
  let i = bodyStart;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  const bodyEnd = i - 1;
  const mutated = src.slice(0, bodyStart) + '\n' + oldBody + '\n' + src.slice(bodyEnd);
  if (mutated === src) return 'isGoalDone mutation produced no change';

  const scratch = makeScratch();
  const mutatedPath = path.join(scratch, 'supervisor-old-isgoaldone.js');
  fs.writeFileSync(mutatedPath, mutated);

  // max-cycles=3 so the cap fires deterministically once done never triggers.
  const r = runSupervisor({ scratch: scratch, supervisorPath: mutatedPath, maxCycles: 3 });

  if (r.code === 0) {
    return 'old isGoalDone still exited 0 on the real object schema - test is vacuous';
  }
  process.stderr.write(
    '[autoloop.test] NON-VACUITY: old array/status isGoalDone returned not-done for ' +
    'the real {criteria:[{passes:true}]} schema. Supervisor exited ' + r.code +
    ' (not 0 via done). The fixed code exits 0. Assertion is non-vacuous.\n'
  );
});

// ---------- summary ----------
if (failures > 0) {
  console.log('AUTOLOOP TESTS FAILED: ' + failures + ' of ' + caseNo);
  process.exit(1);
}
console.log('ALL AUTOLOOP TESTS PASSED (' + caseNo + ' checks)');
