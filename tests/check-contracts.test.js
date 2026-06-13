#!/usr/bin/env node
// Decision tests for scripts/check-contracts.js including DEPENDS-ON rules.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CHECKER = path.join(__dirname, '..', 'scripts', 'check-contracts.js');
const GOOD = 'TASK: a\nEMPLOYEE: e\nSKILL: none\nINPUTS: i\nOUTPUT: o\nDONE-WHEN: d\nVERIFY-WITH: grep -c x file.md\nOUT-OF-SCOPE: s\nROI: high - unblocks triage ordering\nDEPENDS-ON: none\n';
let failures = 0, n = 0;
function run(content) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), 't.md');
  fs.writeFileSync(f, content);
  try { execFileSync(process.execPath, [CHECKER, f], { encoding: 'utf8' }); return 0; }
  catch (e) { return e.status; }
}
function check(name, content, expectExit) {
  n += 1;
  const got = run(content);
  if ((got === 0) === (expectExit === 0)) console.log('ok: case ' + n + ' ' + name);
  else { console.log('FAIL case ' + n + ' (' + name + '): exit ' + got); failures += 1; }
}
check('well-formed passes', GOOD, 0);
check('missing fields fail', 'TASK: a\nEMPLOYEE: e\nVERIFY-WITH: x\n', 1);
check('valid dependency passes', GOOD + '\n' + GOOD.replace('DEPENDS-ON: none', 'DEPENDS-ON: 1'), 0);
check('missing dep target fails', GOOD.replace('DEPENDS-ON: none', 'DEPENDS-ON: 9'), 1);
check('self dependency fails', GOOD.replace('DEPENDS-ON: none', 'DEPENDS-ON: 1'), 1);
check('cycle fails', GOOD.replace('DEPENDS-ON: none', 'DEPENDS-ON: 2') + '\n' + GOOD.replace('DEPENDS-ON: none', 'DEPENDS-ON: 1'), 1);
check('prose with incidental digit fails clearly', GOOD.replace('DEPENDS-ON: none', 'DEPENDS-ON: see the v3 plan'), 1);
check('comma list passes', GOOD + '\n' + GOOD + '\n' + GOOD.replace('DEPENDS-ON: none', 'DEPENDS-ON: 1, 2'), 0);
check('absent MODEL passes (defaults mid)', GOOD, 0);
check('MODEL tier with justification passes', GOOD + 'MODEL: strong, public-facing security text\n', 0);
check('MODEL cheap passes', GOOD + 'MODEL: cheap\n', 0);
check('MODEL with a model name fails', GOOD + 'MODEL: haiku\n', 1);
check('MODEL empty fails', GOOD + 'MODEL: \n', 1);
// 8g fix: vacuous VERIFY-WITH values that meet the old length threshold must now fail.
check('8g: "yes done" (vacuous 8-char filler) fails', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: yes done'), 1);
check('8g: "test -f x && echo PASS" (real command) passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: test -f x && echo PASS'), 0);
check('8g: "gh pr view 1" (gh command) passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: gh pr view 1'), 0);
check('8g: "https://x/y" (URL) passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: https://x/y'), 0);
// Short valid commands that are under 8 chars must pass (length threshold removed).
check('short: "git log" (7 chars) passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: git log'), 0);
check('short: "ls ." (4 chars) passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: ls .'), 0);
check('short: "cat x" (5 chars) passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: cat x'), 0);
check('empty VERIFY-WITH still fails', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH:'), 1);
// ROI field: missing ROI fails, empty ROI fails, valid ROI passes.
check('missing ROI fails', GOOD.replace('ROI: high - unblocks triage ordering\n', ''), 1);
check('empty ROI fails', GOOD.replace('ROI: high - unblocks triage ordering', 'ROI:'), 1);
check('valid ROI passes', GOOD, 0);
// NIT: VERIFY-WITH loosening - named-URL screenshot and playwright forms must pass.
check('screenshot URL form passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: screenshot http://127.0.0.1:3000/path'), 0);
check('open URL form passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: open http://127.0.0.1:3001/dashboard'), 0);
check('playwright verb passes', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: playwright run e2e-suite'), 0);
// Vacuity hole must stay closed: pure filler without a concrete anchor still fails.
check('filler "review the PR manually" still fails', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: review the PR manually'), 1);
check('filler "check it looks right" still fails', GOOD.replace('VERIFY-WITH: grep -c x file.md', 'VERIFY-WITH: check it looks right'), 1);
if (failures) { console.log('CHECK-CONTRACTS TESTS FAILED: ' + failures); process.exit(1); }
console.log('ALL CHECK-CONTRACTS TESTS PASSED (' + n + ' checks)');
