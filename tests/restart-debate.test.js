#!/usr/bin/env node

// Tests for scripts/restart-debate.js.
// Covers: missing/empty required fields -> exit 1 no artifact,
// all 3 present -> exit 0 artifact written with correct fields.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'restart-debate.js');

let failures = 0;
let caseNo = 0;

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'restart-debate-test-'));
}

// Run the script with given stdin JSON string and return { code, stdout, stderr }.
function run(stdinStr, companyDir, env) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: Object.assign({}, process.env, { COMPANY_DIR: companyDir }, env || {}),
    encoding: 'utf8',
    input: stdinStr,
  });
  return {
    code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function check(name, fn) {
  caseNo += 1;
  try {
    const err = fn();
    if (err) {
      console.log('FAIL case ' + caseNo + ' (' + name + '): ' + err);
      failures += 1;
    } else {
      console.log('ok: case ' + caseNo + ' ' + name);
    }
  } catch (e) {
    console.log('FAIL case ' + caseNo + ' (' + name + '): threw: ' + e.message);
    failures += 1;
  }
}

const ARTIFACT = 'RESTART_DEBATE_CONFIRMED';

// Case 1: missing sourceVerifier -> exit 1, no artifact.
check('missing sourceVerifier exits 1', function () {
  const d = freshDir();
  const r = run(JSON.stringify({ devilsAdvocate: 'ok', completenessCritic: 'ok' }), d);
  if (r.code !== 1) return 'expected exit 1, got ' + r.code;
  if (fs.existsSync(path.join(d, ARTIFACT))) return 'artifact must not be written on failure';
  if (r.stderr.indexOf('sourceVerifier') === -1) return 'expected "sourceVerifier" in stderr';
});

// Case 2: missing devilsAdvocate -> exit 1, no artifact.
check('missing devilsAdvocate exits 1', function () {
  const d = freshDir();
  const r = run(JSON.stringify({ sourceVerifier: 'ok', completenessCritic: 'ok' }), d);
  if (r.code !== 1) return 'expected exit 1, got ' + r.code;
  if (fs.existsSync(path.join(d, ARTIFACT))) return 'artifact must not be written on failure';
  if (r.stderr.indexOf('devilsAdvocate') === -1) return 'expected "devilsAdvocate" in stderr';
});

// Case 3: missing completenessCritic -> exit 1, no artifact.
check('missing completenessCritic exits 1', function () {
  const d = freshDir();
  const r = run(JSON.stringify({ sourceVerifier: 'ok', devilsAdvocate: 'ok' }), d);
  if (r.code !== 1) return 'expected exit 1, got ' + r.code;
  if (fs.existsSync(path.join(d, ARTIFACT))) return 'artifact must not be written on failure';
  if (r.stderr.indexOf('completenessCritic') === -1) return 'expected "completenessCritic" in stderr';
});

// Case 4: empty (whitespace-only) sourceVerifier -> exit 1, no artifact.
check('empty sourceVerifier exits 1', function () {
  const d = freshDir();
  const r = run(JSON.stringify({ sourceVerifier: '   ', devilsAdvocate: 'ok', completenessCritic: 'ok' }), d);
  if (r.code !== 1) return 'expected exit 1, got ' + r.code;
  if (fs.existsSync(path.join(d, ARTIFACT))) return 'artifact must not be written on failure';
});

// Case 5: empty devilsAdvocate -> exit 1, no artifact.
check('empty devilsAdvocate exits 1', function () {
  const d = freshDir();
  const r = run(JSON.stringify({ sourceVerifier: 'ok', devilsAdvocate: '', completenessCritic: 'ok' }), d);
  if (r.code !== 1) return 'expected exit 1, got ' + r.code;
  if (fs.existsSync(path.join(d, ARTIFACT))) return 'artifact must not be written on failure';
});

// Case 6: all 3 present -> exit 0, artifact written with the 3 verdicts.
check('all 3 present exits 0 and writes artifact', function () {
  const d = freshDir();
  const input = {
    sourceVerifier: 'All claims confirmed',
    devilsAdvocate: 'No stale lines found',
    completenessCritic: 'All PRs listed',
  };
  const r = run(JSON.stringify(input), d);
  if (r.code !== 0) return 'expected exit 0, got ' + r.code + ' stderr=' + r.stderr;
  const artifactFile = path.join(d, ARTIFACT);
  if (!fs.existsSync(artifactFile)) return 'artifact file not written';
  const rec = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  if (rec.sourceVerifier !== input.sourceVerifier) return 'sourceVerifier mismatch';
  if (rec.devilsAdvocate !== input.devilsAdvocate) return 'devilsAdvocate mismatch';
  if (rec.completenessCritic !== input.completenessCritic) return 'completenessCritic mismatch';
  if (typeof rec.recordedAtTokensMarker !== 'number') return 'recordedAtTokensMarker not a number';
  // stdout must be the artifact path
  if (r.stdout !== artifactFile) return 'stdout must be the artifact path, got: ' + r.stdout;
});

// Case 7: sessionId from env is stored in artifact.
check('sessionId from env stored in artifact', function () {
  const d = freshDir();
  const input = {
    sourceVerifier: 'CONFIRMED',
    devilsAdvocate: 'OK',
    completenessCritic: 'OK',
  };
  const r = run(JSON.stringify(input), d, { CLAUDE_CODE_SESSION_ID: 'test-session-abc123' });
  if (r.code !== 0) return 'expected exit 0, got ' + r.code;
  const rec = JSON.parse(fs.readFileSync(path.join(d, ARTIFACT), 'utf8'));
  if (rec.sessionId !== 'test-session-abc123') return 'sessionId mismatch: ' + rec.sessionId;
});

// Case 8: optional claimsVerified field is preserved when provided.
check('optional claimsVerified is stored when provided', function () {
  const d = freshDir();
  const input = {
    sourceVerifier: 'CONFIRMED',
    devilsAdvocate: 'OK',
    completenessCritic: 'OK',
    claimsVerified: 'SHA abc123, PR #42 open',
  };
  const r = run(JSON.stringify(input), d);
  if (r.code !== 0) return 'expected exit 0, got ' + r.code;
  const rec = JSON.parse(fs.readFileSync(path.join(d, ARTIFACT), 'utf8'));
  if (rec.claimsVerified !== input.claimsVerified) return 'claimsVerified mismatch';
});

// Case 9: claimsVerified absent -> field not present in artifact.
check('absent claimsVerified not present in artifact', function () {
  const d = freshDir();
  const input = { sourceVerifier: 'CONFIRMED', devilsAdvocate: 'OK', completenessCritic: 'OK' };
  const r = run(JSON.stringify(input), d);
  if (r.code !== 0) return 'expected exit 0, got ' + r.code;
  const rec = JSON.parse(fs.readFileSync(path.join(d, ARTIFACT), 'utf8'));
  if ('claimsVerified' in rec) return 'claimsVerified should be absent';
});

// Case 10: garbled stdin -> exit 1, no artifact.
check('garbled stdin exits 1', function () {
  const d = freshDir();
  const r = run('not valid json', d);
  if (r.code !== 1) return 'expected exit 1, got ' + r.code;
  if (fs.existsSync(path.join(d, ARTIFACT))) return 'artifact must not be written on failure';
});

// Case 11: empty stdin -> exit 1.
check('empty stdin exits 1', function () {
  const d = freshDir();
  const r = run('', d);
  if (r.code !== 1) return 'expected exit 1, got ' + r.code;
});

// Summary
if (failures > 0) {
  console.log('RESTART-DEBATE TESTS FAILED: ' + failures);
  process.exit(1);
}
console.log('ALL RESTART-DEBATE TESTS PASSED (' + caseNo + ' checks)');
