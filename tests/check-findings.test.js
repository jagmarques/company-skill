#!/usr/bin/env node
// Decision tests for scripts/check-findings.js including the 8h bare-SOURCE fix.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CHECKER = path.join(__dirname, '..', 'scripts', 'check-findings.js');
let failures = 0, n = 0;
function run(content) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-')), 'f.md');
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
check('well-formed finding passes', 'FINDING: something\nSOURCE: some-file.js\n', 0);
check('FINDING missing SOURCE fails', 'FINDING: something\n', 1);
check('NOVEL marker accepted', 'FINDING: new idea\nNOVEL - needs validation\n', 0);
check('two findings both sourced passes', 'FINDING: a\nSOURCE: x\nFINDING: b\nSOURCE: y\n', 0);
check('second finding unsourced fails', 'FINDING: a\nSOURCE: x\nFINDING: b\n', 1);
// 8h fix: bare "SOURCE:" with no value must now be rejected.
check('8h: bare SOURCE: (no value) fails', 'FINDING: something\nSOURCE:\n', 1);
check('8h: SOURCE: with whitespace only fails', 'FINDING: something\nSOURCE:   \n', 1);
check('8h: SOURCE: x (non-empty) passes', 'FINDING: something\nSOURCE: x\n', 0);
check('8h: SOURCE: /path/to/file passes', 'FINDING: something\nSOURCE: /path/to/file\n', 0);
if (failures) { console.log('CHECK-FINDINGS TESTS FAILED: ' + failures); process.exit(1); }
console.log('ALL CHECK-FINDINGS TESTS PASSED (' + n + ' checks)');
