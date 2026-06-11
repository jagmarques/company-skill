#!/usr/bin/env node
// Decision tests for scripts/check-contracts.js including DEPENDS-ON rules.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CHECKER = path.join(__dirname, '..', 'scripts', 'check-contracts.js');
const GOOD = 'TASK: a\nEMPLOYEE: e\nSKILL: none\nINPUTS: i\nOUTPUT: o\nDONE-WHEN: d\nVERIFY-WITH: grep -c x file.md\nOUT-OF-SCOPE: s\nDEPENDS-ON: none\n';
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
if (failures) { console.log('CHECK-CONTRACTS TESTS FAILED: ' + failures); process.exit(1); }
console.log('ALL CHECK-CONTRACTS TESTS PASSED (' + n + ' checks)');
