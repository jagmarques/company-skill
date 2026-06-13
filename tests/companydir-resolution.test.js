#!/usr/bin/env node

// Non-vacuous resolution tests for the resolveCompanyDir logic.
// These tests do NOT set COMPANY_DIR, so they actually exercise the
// cwd-vs-home preference branch added in the companydir-resolution PR.
// Uses isolated tmp HOME + tmp cwd so nothing bleeds from the real env.
//
// Cases:
//   (a) cwd has no .company; home/.company has a clean OWNER with sid-a.
//       Running as sid-a: hook resolves to home, finds criteria, BLOCKS.
//   (b) Both have clean OWNER. cwd has sid-b. Running as sid-b: cwd wins,
//       not hijacked by home (which has a different sid).
//   (c) home/.company OWNER is empty (garbled). cwd has no .company.
//       Running as any session: home must NOT win. Hook falls back to
//       cwd/.company (nonexistent) and ALLOWS. This is the BLOCKER-1 case.
//   (d) Neither dir has OWNER. cwd/.company has failing criteria.
//       Legacy gate-all: hook resolves to cwd, BLOCKS.

'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STOP_GUARD = path.join(__dirname, '..', 'hooks', 'stop-guard.js');

let failures = 0;
let caseNo = 0;

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

// Run stop-guard without COMPANY_DIR set, controlling HOME and cwd.
function runWithEnv(opts) {
  const env = Object.assign({}, process.env);
  delete env.COMPANY_DIR;
  env.HOME = opts.home;
  try {
    return execFileSync(process.execPath, [STOP_GUARD], {
      env: env,
      cwd: opts.cwd,
      encoding: 'utf8',
      input: opts.input,
    });
  } catch (e) {
    return e.stdout || '';
  }
}

function decide(out) {
  if (!out || out.trim() === '') return 'allow';
  try {
    const parsed = JSON.parse(out.trim());
    return parsed.decision === 'block' ? 'block' : 'allow';
  } catch (_) { return 'allow'; }
}

function check(name, outcome, expected) {
  caseNo += 1;
  if (outcome === expected) {
    console.log('ok: case ' + caseNo + ' ' + name);
  } else {
    console.log('FAIL case ' + caseNo + ' (' + name + '): expected ' + expected + ', got ' + outcome);
    failures += 1;
  }
}

// Write a failing criteria.json so the hook blocks when it resolves to this dir.
function writeFailing(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'GOAL.md'), 'test goal');
  fs.writeFileSync(path.join(dir, 'criteria.json'), JSON.stringify({
    criteria: [{ id: 1, description: 'not done', passes: false, evidence: null }],
  }));
}

// ----------------------------------------------------------------
// Case (a): cwd has no .company; home/.company has a clean OWNER
//           containing the running session id.
//           Expected: hook resolves to home (clean OWNER wins), BLOCKS.
// ----------------------------------------------------------------
{
  const SID = 'owner-session-home1';
  const home = freshDir('res-a-home');
  const cwd = freshDir('res-a-cwd');
  const homeCompany = path.join(home, '.company');
  writeFailing(homeCompany);
  fs.writeFileSync(path.join(homeCompany, 'OWNER'), SID + '\n');
  const out = runWithEnv({
    home,
    cwd,
    input: JSON.stringify({ session_id: SID }),
  });
  check('(a) home clean OWNER -> resolves to home, blocks', decide(out), 'block');
}

// ----------------------------------------------------------------
// Case (b): both dirs have .company with clean OWNER.
//           cwd has failing criteria; home has no criteria (would allow).
//           Running session is in cwd OWNER only.
//           Expected: cwd wins (project-local), BLOCKS (not hijacked by home).
// ----------------------------------------------------------------
{
  const SID_CWD = 'owner-session-cwd11';
  const SID_HOME = 'owner-session-home2';
  const home = freshDir('res-b-home');
  const cwd = freshDir('res-b-cwd');
  const cwdCompany = path.join(cwd, '.company');
  const homeCompany = path.join(home, '.company');
  writeFailing(cwdCompany);
  fs.writeFileSync(path.join(cwdCompany, 'OWNER'), SID_CWD + '\n');
  // home has .company + clean OWNER but no criteria (would allow if resolved there).
  fs.mkdirSync(homeCompany, { recursive: true });
  fs.writeFileSync(path.join(homeCompany, 'OWNER'), SID_HOME + '\n');
  const out = runWithEnv({
    home,
    cwd,
    input: JSON.stringify({ session_id: SID_CWD }),
  });
  // cwd wins -> criteria found -> block. If home won -> no criteria -> allow.
  check('(b) cwd clean OWNER wins over home, not hijacked', decide(out), 'block');
}

// ----------------------------------------------------------------
// Case (c): home/.company OWNER is empty (1-byte newline, like `echo $UNSET_VAR`).
//           home/.company has failing criteria.
//           cwd has no .company.
//           Expected: home must NOT win (BLOCKER-1 fix). Hook falls back to
//           cwd/.company (nonexistent) and ALLOWS the unrelated session.
// ----------------------------------------------------------------
{
  const home = freshDir('res-c-home');
  const cwd = freshDir('res-c-cwd');
  const homeCompany = path.join(home, '.company');
  writeFailing(homeCompany);
  // Empty/garbled OWNER: simulates `echo $UNSET_VAR > OWNER` = 1-byte newline.
  fs.writeFileSync(path.join(homeCompany, 'OWNER'), '\n');
  const out = runWithEnv({
    home,
    cwd,
    input: JSON.stringify({ session_id: 'completely-unrelated-999' }),
  });
  // Post-fix: empty OWNER -> home does not qualify -> cwd fallback (nonexistent) -> allow.
  check('(c) empty home OWNER does not contaminate unrelated cwd (BLOCKER-1)', decide(out), 'allow');
}

// ----------------------------------------------------------------
// Case (d): neither dir has OWNER. cwd/.company has failing criteria.
//           Legacy gate-all: no OWNER file means gate every session.
//           Expected: cwd fallback, BLOCKS.
// ----------------------------------------------------------------
{
  const home = freshDir('res-d-home');
  const cwd = freshDir('res-d-cwd');
  const cwdCompany = path.join(cwd, '.company');
  writeFailing(cwdCompany);
  const out = runWithEnv({
    home,
    cwd,
    input: JSON.stringify({ session_id: 'some-session-id00' }),
  });
  // No OWNER anywhere -> fall back to cwd/.company -> criteria found -> legacy gate-all -> block.
  check('(d) no OWNER -> cwd fallback, legacy gate-all, blocks', decide(out), 'block');
}

// ----------------------------------------------------------------
// Summary
// ----------------------------------------------------------------
if (failures === 0) {
  console.log('ALL ' + caseNo + ' RESOLUTION CASES PASSED');
  process.exit(0);
} else {
  console.log(failures + '/' + caseNo + ' RESOLUTION CASES FAILED');
  process.exit(1);
}
