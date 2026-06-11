#!/usr/bin/env node
// Mechanical gate for findings files: every FINDING line must be followed by
// a SOURCE line (or NOVEL marker) before the next FINDING. Run at VERIFY:
//   node scripts/check-findings.js .company/<dept>/<employee>.md [...]
// Exit 1 names each unsourced finding. A claim without a source is unverifiable.
const fs = require('fs');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: check-findings.js <findings-file...>'); process.exit(2); }
let bad = 0, total = 0;
files.forEach(file => {
  if (!fs.existsSync(file)) { console.error(file + ': missing'); bad += 1; return; }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/^FINDING:/.test(l)) return;
    total += 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^FINDING:/.test(lines[j])) break;
      if (/^SOURCE:|NOVEL - needs validation/.test(lines[j])) return;
    }
    bad += 1;
    console.error(file + ':' + (i + 1) + ' FINDING without SOURCE: ' + l.slice(0, 70));
  });
});
if (bad) { console.error(bad + ' unsourced findings'); process.exit(1); }
console.log(total + ' findings all sourced');
