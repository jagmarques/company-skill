#!/usr/bin/env node

// Decision-logic tests for precompact.js and session-restore.js OWNER handling.
// Specifically tests the garbled-OWNER bug where raw indexOf was used without
// regex validation, causing real sessions to be skipped when OWNER had any
// garbled bytes (even though the valid session id was present).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRECOMPACT = path.join(__dirname, '..', 'hooks', 'precompact.js');
const RESTORE = path.join(__dirname, '..', 'hooks', 'session-restore.js');

let failures = 0;
let caseNo = 0;

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-owner-test-'));
}

function runHook(hookPath, dir, sessionId) {
  const input = sessionId !== undefined
    ? JSON.stringify({ session_id: sessionId })
    : JSON.stringify({});
  try {
    return execFileSync(process.execPath, [hookPath], {
      env: Object.assign({}, process.env, { COMPANY_DIR: dir }),
      encoding: 'utf8',
      input: input,
    });
  } catch (e) {
    return 'CRASH:' + e.message;
  }
}

// --- precompact.js OWNER tests ---

// P1: garbled OWNER + real session -> checkpoint IS written (fall-through, not skip).
{
  caseNo += 1;
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'OWNER'), Buffer.from([0, 1, 255, 10, 104, 105, 33, 33]));
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'Test goal');
  runHook(PRECOMPACT, d, 'real-owner-session1');
  const chk = path.join(d, '.checkpoint.md');
  if (fs.existsSync(chk)) {
    console.log('ok: case ' + caseNo + ' precompact: garbled OWNER -> checkpoint written (fall-through)');
  } else {
    console.log('FAIL case ' + caseNo + ' (precompact garbled OWNER): checkpoint not written');
    failures += 1;
  }
}

// P2: clean OWNER, session IS listed -> checkpoint written.
{
  caseNo += 1;
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'OWNER'), 'owner-session-abc1\n');
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'Test goal');
  runHook(PRECOMPACT, d, 'owner-session-abc1');
  const chk = path.join(d, '.checkpoint.md');
  if (fs.existsSync(chk)) {
    console.log('ok: case ' + caseNo + ' precompact: clean OWNER + listed session -> checkpoint written');
  } else {
    console.log('FAIL case ' + caseNo + ' (precompact listed session): checkpoint not written');
    failures += 1;
  }
}

// P3: clean OWNER, session NOT listed -> checkpoint NOT written (foreign session).
{
  caseNo += 1;
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'OWNER'), 'owner-session-abc2\n');
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'Test goal');
  runHook(PRECOMPACT, d, 'foreign-session-xyz9');
  const chk = path.join(d, '.checkpoint.md');
  if (!fs.existsSync(chk)) {
    console.log('ok: case ' + caseNo + ' precompact: clean OWNER + foreign session -> checkpoint NOT written');
  } else {
    console.log('FAIL case ' + caseNo + ' (precompact foreign session): checkpoint was written');
    failures += 1;
  }
}

// P4: no OWNER file (legacy) -> checkpoint written for any session.
{
  caseNo += 1;
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'Test goal');
  runHook(PRECOMPACT, d, 'any-session-123');
  const chk = path.join(d, '.checkpoint.md');
  if (fs.existsSync(chk)) {
    console.log('ok: case ' + caseNo + ' precompact: no OWNER -> checkpoint written (legacy behavior)');
  } else {
    console.log('FAIL case ' + caseNo + ' (precompact no OWNER): checkpoint not written');
    failures += 1;
  }
}

// --- session-restore.js OWNER tests ---

// R1: garbled OWNER + real session -> context IS emitted (fall-through, not skip).
{
  caseNo += 1;
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'OWNER'), Buffer.from([0, 1, 255, 10, 104, 105, 33, 33]));
  fs.writeFileSync(path.join(d, '.checkpoint.md'), '# Company Checkpoint\n## Goal\nTest\n');
  const out = runHook(RESTORE, d, 'real-owner-session2');
  let ok = false;
  try {
    const parsed = JSON.parse(out.trim());
    ok = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === 'string';
  } catch (e) {}
  if (ok) {
    console.log('ok: case ' + caseNo + ' session-restore: garbled OWNER -> context emitted (fall-through)');
  } else {
    console.log('FAIL case ' + caseNo + ' (session-restore garbled OWNER): context not emitted, out=' + out.slice(0, 80));
    failures += 1;
  }
}

// R2: clean OWNER, session IS listed -> context emitted.
{
  caseNo += 1;
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'OWNER'), 'owner-session-def1\n');
  fs.writeFileSync(path.join(d, '.checkpoint.md'), '# Company Checkpoint\n## Goal\nTest\n');
  const out = runHook(RESTORE, d, 'owner-session-def1');
  let ok = false;
  try {
    const parsed = JSON.parse(out.trim());
    ok = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === 'string';
  } catch (e) {}
  if (ok) {
    console.log('ok: case ' + caseNo + ' session-restore: clean OWNER + listed session -> context emitted');
  } else {
    console.log('FAIL case ' + caseNo + ' (session-restore listed session): context not emitted');
    failures += 1;
  }
}

// R3: clean OWNER, foreign session -> NO context emitted (protect foreign sessions).
{
  caseNo += 1;
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'OWNER'), 'owner-session-def2\n');
  fs.writeFileSync(path.join(d, '.checkpoint.md'), '# Company Checkpoint\n## Goal\nTest\n');
  const out = runHook(RESTORE, d, 'foreign-session-abc8');
  const trimmed = out.trim();
  if (trimmed === '') {
    console.log('ok: case ' + caseNo + ' session-restore: clean OWNER + foreign session -> NO context emitted');
  } else {
    console.log('FAIL case ' + caseNo + ' (session-restore foreign session): context was emitted: ' + trimmed.slice(0, 80));
    failures += 1;
  }
}

// R4: no OWNER file (legacy) -> context emitted for any session.
{
  caseNo += 1;
  const d = freshDir();
  fs.writeFileSync(path.join(d, '.checkpoint.md'), '# Company Checkpoint\n## Goal\nTest\n');
  const out = runHook(RESTORE, d, 'any-session-789');
  let ok = false;
  try {
    const parsed = JSON.parse(out.trim());
    ok = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === 'string';
  } catch (e) {}
  if (ok) {
    console.log('ok: case ' + caseNo + ' session-restore: no OWNER -> context emitted (legacy behavior)');
  } else {
    console.log('FAIL case ' + caseNo + ' (session-restore no OWNER): context not emitted');
    failures += 1;
  }
}

if (failures > 0) {
  console.log('HOOKS-OWNER TESTS FAILED: ' + failures);
  process.exit(1);
}
console.log('ALL HOOKS-OWNER TESTS PASSED (' + caseNo + ' checks)');
