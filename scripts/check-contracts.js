#!/usr/bin/env node
// Gate for delegation contracts: every TASK block must carry all required
// fields and a non-empty VERIFY-WITH. MODEL is optional (defaults to mid)
// but must be a valid tier when present. Exit 1 lists each defective contract.
// Run: node scripts/check-contracts.js .company/cycles/cycle-N-tasks.md
const fs = require('fs');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('usage: check-contracts.js <tasks-file>'); process.exit(2); }
const text = fs.readFileSync(file, 'utf8');
const blocks = text.split(/\n(?=TASK:)/).filter(b => b.trim().startsWith('TASK:'));
if (blocks.length === 0) { console.error('no TASK blocks found'); process.exit(1); }
const FIELDS = ['TASK:', 'EMPLOYEE:', 'SKILL:', 'INPUTS:', 'OUTPUT:', 'DONE-WHEN:', 'VERIFY-WITH:', 'OUT-OF-SCOPE:', 'ROI:'];
// DEPENDS-ON is optional. When present it must name existing task numbers and the
// dependency graph must be acyclic.
function checkDeps(blocks) {
  const errs = [];
  const deps = blocks.map((b, i) => {
    const m = b.match(/DEPENDS-ON:\s*(.+)/);
    if (!m) return [];
    const v = m[1].trim();
    if (/^none$/i.test(v)) return [];
    if (!/^\d+(\s*(,|and)\s*\d+)*$/i.test(v)) {
      errs.push('contract ' + (i + 1) + ': DEPENDS-ON must be "none" or task numbers, got: ' + v.slice(0, 40));
      return [];
    }
    return v.match(/\d+/g).map(Number);
  });
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
  // 8g fix: require a command/verb token, path component, URL, or a concrete
  // visual-verify phrase (screenshot/playwright/open + named URL/path) so bare
  // filler like "yes done" is rejected. Named-URL screenshot forms are explicitly
  // allowed per skill guidance ("an equally concrete check, like a named URL").
  const VW_RE = /[/.:]|\b(test|grep|node|python3?|gh|git|curl|cat|ls|npm|make|pytest|diff|echo|jq|bash|sh|playwright)\b|\$\(|`|\|\||&&|screenshot\s+https?:\/\/\S+|open\s+https?:\/\/\S+/;
  if (b.includes('VERIFY-WITH:') && (!vw.length || !VW_RE.test(vw))) errs.push('VERIFY-WITH is empty or vacuous');
  // ROI must have non-empty content after the colon so triage has something to sort on.
  const roi = (b.split('ROI:')[1] || '').split('\n')[0].trim();
  if (b.includes('ROI:') && roi.length < 3) errs.push('ROI is empty or too short');
  // MODEL is optional (absent means mid). When present the tier must be
  // cheap, mid, or strong, optionally followed by the lead's justification.
  const mm = b.match(/^MODEL:\s*(.*)$/m);
  if (mm && !/^(cheap|mid|strong)\b/i.test(mm[1].trim())) {
    errs.push('MODEL must start with cheap, mid, or strong, got: ' + mm[1].trim().slice(0, 40));
  }
  if (errs.length) { bad += 1; console.error('contract ' + (i + 1) + ': ' + errs.join(', ')); }
});
const depErrs = checkDeps(blocks);
depErrs.forEach(e => console.error(e));
if (bad || depErrs.length) { console.error((bad + depErrs.length) + ' defects across ' + blocks.length + ' contracts'); process.exit(1); }
console.log(blocks.length + ' contracts well-formed');
