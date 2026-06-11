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
// DEPENDS-ON is optional. When present it must name existing task numbers
// and the dependency graph must be acyclic.
function checkDeps(blocks) {
  const deps = blocks.map(b => {
    const m = b.match(/DEPENDS-ON:\s*(.+)/);
    if (!m || /^none\b/i.test(m[1].trim())) return [];
    return (m[1].match(/\d+/g) || []).map(Number);
  });
  const errs = [];
  deps.forEach((ds, i) => ds.forEach(d => {
    if (d < 1 || d > blocks.length) errs.push('contract ' + (i + 1) + ': DEPENDS-ON names missing task ' + d);
    if (d === i + 1) errs.push('contract ' + (i + 1) + ': depends on itself');
  }));
  const state = new Array(blocks.length).fill(0);
  function visit(i, trail) {
    if (state[i] === 1) { errs.push('dependency cycle: ' + trail.concat(i + 1).join(' -> ')); return; }
    if (state[i] === 2) return;
    state[i] = 1;
    deps[i].forEach(d => { if (d >= 1 && d <= blocks.length) visit(d - 1, trail.concat(i + 1)); });
    state[i] = 2;
  }
  for (let i = 0; i < blocks.length; i++) visit(i, []);
  return errs;
}
let bad = 0;
blocks.forEach((b, i) => {
  const missing = FIELDS.filter(f => !b.includes(f));
  const vw = (b.split('VERIFY-WITH:')[1] || '').split('\n')[0].trim();
  const errs = [];
  if (missing.length) errs.push('missing ' + missing.join(' '));
  if (b.includes('VERIFY-WITH:') && vw.length < 8) errs.push('VERIFY-WITH is empty or vacuous');
  if (errs.length) { bad += 1; console.error('contract ' + (i + 1) + ': ' + errs.join(', ')); }
});
const depErrs = checkDeps(blocks);
depErrs.forEach(e => console.error(e));
if (bad || depErrs.length) { console.error((bad + depErrs.length) + ' defects across ' + blocks.length + ' contracts'); process.exit(1); }
console.log(blocks.length + ' contracts well-formed');
