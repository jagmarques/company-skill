#!/usr/bin/env node
// Mechanical gate for delegation contracts: every TASK block must carry all
// seven fields and a non-empty VERIFY-WITH. Run before EXECUTE:
//   node scripts/check-contracts.js .company/cycles/cycle-N-tasks.md
// Exit 1 lists each defective contract. No fields, no task.
const fs = require('fs');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('usage: check-contracts.js <tasks-file>'); process.exit(2); }
const text = fs.readFileSync(file, 'utf8');
const blocks = text.split(/\n(?=TASK:)/).filter(b => b.trim().startsWith('TASK:'));
if (blocks.length === 0) { console.error('no TASK blocks found'); process.exit(1); }
const FIELDS = ['TASK:', 'EMPLOYEE:', 'SKILL:', 'INPUTS:', 'OUTPUT:', 'DONE-WHEN:', 'VERIFY-WITH:', 'OUT-OF-SCOPE:'];
let bad = 0;
blocks.forEach((b, i) => {
  const missing = FIELDS.filter(f => !b.includes(f));
  const vw = (b.split('VERIFY-WITH:')[1] || '').split('\n')[0].trim();
  const errs = [];
  if (missing.length) errs.push('missing ' + missing.join(' '));
  if (b.includes('VERIFY-WITH:') && vw.length < 8) errs.push('VERIFY-WITH is empty or vacuous');
  if (errs.length) { bad += 1; console.error('contract ' + (i + 1) + ': ' + errs.join(', ')); }
});
if (bad) { console.error(bad + '/' + blocks.length + ' contracts defective'); process.exit(1); }
console.log(blocks.length + ' contracts well-formed');
