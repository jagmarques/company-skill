#!/usr/bin/env node
// Non-vacuous test for the hasOpenPR fail-safe in scripts/cleanup.js.
// BUG #5: when gh exits 0 but stdout is not valid JSON, the old code
//         returned false (deletable), contradicting the fail-safe contract.
// Post-fix: parse error -> return true (block deletion).
//
// Strategy: prepend a temp dir holding a stub 'gh' binary to PATH,
// then run a child process that sources hasOpenPR from cleanup.js and
// calls it, printing 'true' or 'false'.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLEANUP = path.join(__dirname, '..', 'scripts', 'cleanup.js');

let failures = 0;
let caseNo = 0;

function check(name, got, expected) {
  caseNo += 1;
  if (got === expected) {
    console.log('ok: case ' + caseNo + ' ' + name);
  } else {
    console.log('FAIL case ' + caseNo + ' (' + name + '): expected ' + expected + ', got ' + got);
    failures += 1;
  }
}

// Write a stub 'gh' script, prepend its dir to PATH, run a mini runner that
// calls hasOpenPR('company/test-branch') and prints the boolean result.
function runHasOpenPR(ghScript) {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stub-'));
  const stubPath = path.join(stubDir, 'gh');
  fs.writeFileSync(stubPath, '#!/bin/sh\n' + ghScript + '\n', { mode: 0o755 });

  // Inline runner: require cleanup.js internals by parsing them out.
  // We write a small runner script that loads the two relevant functions
  // from cleanup.js by appending a call site.
  const runnerSrc = fs.readFileSync(CLEANUP, 'utf8')
    // Prevent the main() call from firing by stripping the entry point.
    .replace(/^main\(\);?\s*$/m, '')
    // Prevent process.exit(1) in repoRoot from killing the runner.
    .replace(/process\.exit\(1\)/g, 'throw new Error("exit1")')
    // Append a call to hasOpenPR and print the result.
    + '\nprocess.stdout.write(String(hasOpenPR("company/test-branch")) + "\\n");\n';

  const runnerPath = path.join(stubDir, 'runner.js');
  fs.writeFileSync(runnerPath, runnerSrc);

  const env = Object.assign({}, process.env, {
    PATH: stubDir + path.delimiter + (process.env.PATH || ''),
  });

  const r = spawnSync(process.execPath, [runnerPath], { encoding: 'utf8', env });
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch (_) {}
  return (r.stdout || '').trim();
}

// ----------------------------------------------------------------
// Case A: gh exits 0 but emits garbage (unparseable JSON).
// Pre-fix: hasOpenPR returns false (incorrectly marks as safe to delete).
// Post-fix: hasOpenPR returns true (fail safe, block deletion).
// ----------------------------------------------------------------
{
  const out = runHasOpenPR('echo "this is not json {{{ garbage"');
  check(
    'BUG #5 A: gh exits 0 with garbage JSON -> hasOpenPR returns true (fail safe)',
    out,
    'true'
  );
}

// ----------------------------------------------------------------
// Case B: gh exits 0 with valid empty array [] -> no PR open -> false (deletable).
// Verifies the fix does not break the happy-path safe-to-delete case.
// ----------------------------------------------------------------
{
  const out = runHasOpenPR('echo "[]"');
  check(
    'BUG #5 B: gh exits 0 with [] -> hasOpenPR returns false (no open PR, safe to delete)',
    out,
    'false'
  );
}

// ----------------------------------------------------------------
// Case C: gh exits 0 with a PR in the list -> open PR -> true (block deletion).
// ----------------------------------------------------------------
{
  const out = runHasOpenPR('printf \'[{"number":42}]\'');
  check(
    'BUG #5 C: gh exits 0 with [{number:42}] -> hasOpenPR returns true (open PR found)',
    out,
    'true'
  );
}

// ----------------------------------------------------------------
// Case D: gh exits non-zero -> fail safe true (existing behavior, must not regress).
// ----------------------------------------------------------------
{
  const out = runHasOpenPR('exit 1');
  check(
    'BUG #5 D: gh exits 1 -> hasOpenPR returns true (fail safe, existing behavior)',
    out,
    'true'
  );
}

if (failures === 0) {
  console.log('ALL ' + caseNo + ' CLEANUP-FAILSAFE TESTS PASSED');
  process.exit(0);
} else {
  console.log(failures + '/' + caseNo + ' CLEANUP-FAILSAFE TESTS FAILED');
  process.exit(1);
}
