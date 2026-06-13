#!/usr/bin/env node

// Decision-logic matrix for hooks/stop-guard.js. Builds a fixture dir per case,
// runs the hook with COMPANY_DIR pointed at it, and asserts allow/block from
// stdout. A block emits JSON with decision "block"; allow exits 0 with no output.
// Included in scripts/check.sh so a future edit cannot silently regress fail-closed.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hooks', 'stop-guard.js');

let failures = 0;
let caseNo = 0;

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stop-guard-test-'));
}

function runHook(dir, opts) {
  opts = opts || {};
  const out = execFileSync(process.execPath, [HOOK], {
    env: Object.assign({}, process.env, { COMPANY_DIR: dir }, opts.env || {}),
    encoding: 'utf8',
    input: opts.input === undefined ? '' : opts.input,
  });
  return out.trim();
}

function decide(out) {
  if (out === '') return 'allow';
  const parsed = JSON.parse(out);
  return parsed.decision === 'block' ? 'block' : 'allow';
}

function check(name, dir, expected, reasonSubstring, opts) {
  caseNo += 1;
  let out;
  try {
    out = runHook(dir, opts);
  } catch (e) {
    console.log('FAIL case ' + caseNo + ' (' + name + '): hook crashed: ' + e.message);
    failures += 1;
    return '';
  }
  const got = decide(out);
  if (got !== expected) {
    console.log('FAIL case ' + caseNo + ' (' + name + '): expected ' + expected + ', got ' + got);
    failures += 1;
  } else if (reasonSubstring && out.indexOf(reasonSubstring) === -1) {
    console.log('FAIL case ' + caseNo + ' (' + name + '): reason missing "' + reasonSubstring + '": ' + out);
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' ' + name);
  }
  return out;
}

function writeCriteria(dir, value) {
  fs.writeFileSync(path.join(dir, 'criteria.json'),
    typeof value === 'string' ? value : JSON.stringify(value));
}

// 1. No company state: hook must allow silently.
{
  const d = freshDir();
  check('no state allows', d, 'allow');
}

// 2. CANCEL file allows the stop.
{
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'goal');
  writeCriteria(d, { criteria: [{ id: 1, description: 'x', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'CANCEL'), '');
  check('cancel allows', d, 'allow');
  // Regression pin: CANCEL must persist so a second stop also allows (single-use bug).
  caseNo += 1;
  if (!fs.existsSync(path.join(d, 'CANCEL'))) {
    console.log('FAIL case ' + caseNo + ' (cancel persists): CANCEL file was deleted');
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' cancel file persists after first allow');
  }
  // Second run on the same fixture must also allow - catches the old single-use defect.
  check('cancel allows on second run too', d, 'allow');
}

// 2c. Removing CANCEL re-arms the gate: a failing-criteria run blocks again.
{
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'goal');
  writeCriteria(d, { criteria: [{ id: 1, description: 'x', passes: false, evidence: null }] });
  check('no cancel blocks', d, 'block', 'criteria not met');
  fs.writeFileSync(path.join(d, 'CANCEL'), '');
  check('cancel added allows', d, 'allow');
  fs.unlinkSync(path.join(d, 'CANCEL'));
  check('cancel removed blocks again', d, 'block', 'criteria not met');
}

// 3. Unparseable JSON fails closed.
{
  const d = freshDir();
  writeCriteria(d, '{not json');
  check('broken json blocks', d, 'block', 'unparseable');
}

// 4. Parseable but wrong shape fails closed.
{
  const d = freshDir();
  writeCriteria(d, { criteria: 'not-an-array' });
  check('wrong shape blocks', d, 'block', 'wrong shape');
}

// 5. Zero criteria fails closed.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [] });
  check('zero criteria blocks', d, 'block', 'zero criteria');
}

// 6. A failing criterion blocks.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'ship it', passes: false, evidence: null }] });
  check('failing criterion blocks', d, 'block', 'ship it');
}

// 7. passes:true without evidence still blocks; evidence is the contract.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'ev gap', passes: true, evidence: null }] });
  check('passes without evidence blocks', d, 'block', 'ev gap');
}

// 8. All criteria passing with evidence allows the stop.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [
    { id: 1, description: 'a', passes: true, evidence: 'cmd + result' },
    { id: 2, description: 'b', passes: true, evidence: 'cmd + result' },
  ] });
  check('all passing allows', d, 'allow');
}

// 9. A null entry in the array counts as failing, never as a crash.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [null, { id: 1, description: 'a', passes: true, evidence: 'e' }] });
  check('malformed entry blocks', d, 'block', 'malformed entry');
}

// 10. Goal without criteria.json blocks.
{
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'goal');
  check('goal without criteria blocks', d, 'block', 'criteria.json');
}

// 11. A stale file still blocks and the reason surfaces the age.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'old run', passes: false, evidence: null }] });
  const old = (Date.now() - 30 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(d, 'criteria.json'), old, old);
  check('stale still blocks with age note', d, 'block', 'untouched for');
}

// 12. A foreign session passes when OWNER names a different session.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'OWNER'), 'owner-aaa\n');
  check('foreign session passes owner gate', d, 'allow', null,
    { input: JSON.stringify({ session_id: 'other-bbb' }) });
}

// 13. The owning session still blocks, with its id tagged in the reason.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'OWNER'), 'owner-aaa\n');
  check('owner session still blocks', d, 'block', '[session owner-aaa]',
    { input: JSON.stringify({ session_id: 'owner-aaa' }) });
}

// 14. Missing OWNER is legacy state: every session blocks (fail closed).
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  check('missing OWNER blocks any session', d, 'block', 'criteria not met',
    { input: JSON.stringify({ session_id: 'any-ccc' }) });
}

// 15. The exempt file frees a listed session even when OWNER names it.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'OWNER'), 'stuck-ddd\n');
  const home = freshDir();
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'hooks', 'company-guard-exempt.txt'), 'stuck-ddd\n');
  check('exempt file frees a listed session', d, 'allow', null,
    { input: JSON.stringify({ session_id: 'stuck-ddd' }), env: { HOME: home } });
}

// 16. Multi-line OWNER gates every listed session.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'OWNER'), 'owner-aaa\nowner-eee\n');
  check('second listed owner blocks too', d, 'block', '[session owner-eee]',
    { input: JSON.stringify({ session_id: 'owner-eee' }) });
}

// 17. Deleting a locked criterion blocks even when everything remaining passes.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [
    { id: 1, description: 'easy', passes: false, evidence: null },
    { id: 2, description: 'hard', passes: false, evidence: null }] });
  runHook(d); // first sight snapshots ids 1,2 into criteria.lock
  writeCriteria(d, { criteria: [
    { id: 1, description: 'easy', passes: true, evidence: 'real' }] });
  check('deleting a locked criterion blocks', d, 'block', 'locked criterion');
}

// 18. Adding a criterion extends the lock; a fully passing set allows.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [
    { id: 1, description: 'a', passes: false, evidence: null }] });
  runHook(d); // lock holds id 1
  writeCriteria(d, { criteria: [
    { id: 1, description: 'a', passes: true, evidence: 'real' },
    { id: 2, description: 'added by reviewer', passes: true, evidence: 'real' }] });
  check('added criterion extends lock and passing set allows', d, 'allow');
  const lock = fs.readFileSync(path.join(d, 'criteria.lock'), 'utf8');
  caseNo += 1;
  if (lock.indexOf('2') === -1) {
    console.log('FAIL case ' + caseNo + ' (lock extended with new id): id 2 missing from lock');
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' lock extended with new id');
  }
}

// 19. The block reason must not reveal the cancel command to the model.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  const out = check('failing criteria block reason exists', d, 'block', 'criteria not met');
  caseNo += 1;
  if (out.indexOf('touch .company/CANCEL') !== -1) {
    console.log('FAIL case ' + caseNo + ' (cancel command not advertised): reason names the override');
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' cancel command not advertised');
  }
}

// 22. A garbled OWNER file fails closed: every session stays gated.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'OWNER'), Buffer.from([0, 1, 255, 10, 104, 105, 33, 33]));
  check('garbled OWNER fails closed', d, 'block', 'criteria not met',
    { input: JSON.stringify({ session_id: 'innocent-session-1' }) });
}

// 23. A reviewer note on a failing criterion surfaces in the block reason.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'deploy verified', passes: false, evidence: null, note: 'prod still on old sha, re-probe after deploy' }] });
  check('failing criterion note surfaces', d, 'block', 'prod still on old sha');
}

// 24. The block reason opens with the goal's first line when GOAL.md exists.
{
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'ship the payments retry queue\nmore detail');
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  check('goal line opens the block reason', d, 'block', 'GOAL: ship the payments retry queue');
}

// 25. 3d fix: deleting criteria.lock is now a no-op; external lock is authoritative.
// With a writable home, first sight writes the external lock. Deleting .company/criteria.lock
// and shrinking criteria.json must still BLOCK because the external lock retains the full set.
{
  const d = freshDir();
  const home = freshDir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeCriteria(d, { criteria: [
    { id: 1, description: 'easy', passes: false, evidence: null },
    { id: 2, description: 'hard', passes: false, evidence: null }] });
  runHook(d, { env: { HOME: home } }); // first sight: external lock written with ids 1,2
  // Delete the .company lock and shrink criteria to only id 1 (id 2 removed).
  try { fs.unlinkSync(path.join(d, 'criteria.lock')); } catch (e) {}
  writeCriteria(d, { criteria: [{ id: 1, description: 'easy', passes: true, evidence: 'real' }] });
  check('3d: rm criteria.lock + shrink still blocks via external lock', d, 'block',
    'locked criterion', { env: { HOME: home } });
}

// 26. 4d fix: owner rewriting OWNER to evict itself must still block.
// The session is first seen as a valid owner (OWNER contains it) and recorded in
// the external owners log. It then rewrites OWNER to a different id - the external
// log still has it, so it is NOT treated as foreign and is still blocked.
{
  const d = freshDir();
  const home = freshDir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'OWNER'), 'real-owner-aaaa1111\n');
  // First run: records real-owner-aaaa1111 in external owners log.
  runHook(d, { input: JSON.stringify({ session_id: 'real-owner-aaaa1111' }), env: { HOME: home } });
  // Now evict: rewrite OWNER to a different valid id.
  fs.writeFileSync(path.join(d, 'OWNER'), 'other-session-bbbb2222\n');
  // The real owner should still be BLOCKED because it is in the external log.
  check('4d: owner rewrites OWNER to evict self still blocks', d, 'block', 'criteria not met',
    { input: JSON.stringify({ session_id: 'real-owner-aaaa1111' }), env: { HOME: home } });
}

// 27. 4a regression: a genuinely foreign session (never in OWNER, never in external log)
// must still be allowed (not gated). This confirms the 4d fix does not break 4a.
{
  const d = freshDir();
  const home = freshDir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'OWNER'), 'real-owner-cccc3333\n');
  // Run once to establish the real owner in the external log.
  runHook(d, { input: JSON.stringify({ session_id: 'real-owner-cccc3333' }), env: { HOME: home } });
  // A totally unrelated session must still be exempt.
  check('4a regression: foreign session (never in OWNER or external log) exempt',
    d, 'allow', null,
    { input: JSON.stringify({ session_id: 'unrelated-dddd4444' }), env: { HOME: home } });
}

// 28. Degrade path: when HOME points at an unwritable/nonexistent location, the hook
// must not crash and must still block as before (no fail-open beyond today's baseline).
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'a', passes: false, evidence: null }] });
  check('degrade: unwritable HOME does not crash and still blocks', d, 'block', 'criteria not met',
    { env: { HOME: '/nonexistent-location-xyz-degrade-test' } });
}

// 29. New-goal clear: removing the external anchor dir lets a fresh run re-snapshot.
// This simulates the SKILL.md Parse step clearing the anchor so a new goal starts clean.
{
  const d = freshDir();
  const home = freshDir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const crypto = require('crypto');
  const real = fs.realpathSync(d);
  const key = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
  const anchorPath = require('path').join(home, '.claude', 'company-guard-state', key);
  writeCriteria(d, { criteria: [
    { id: 1, description: 'old', passes: false, evidence: null },
    { id: 2, description: 'old2', passes: false, evidence: null }] });
  runHook(d, { env: { HOME: home } }); // first sight: external lock written with 1,2
  // Simulate new-goal clear: remove the external anchor dir AND the .company lock
  // (the Parse step clears both for a new goal, symmetric with the existing stale-lock clear).
  fs.rmSync(anchorPath, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(d, 'criteria.lock')); } catch (e) {}
  // Now use new criteria with only id 3 - no external lock, so fresh first sight.
  writeCriteria(d, { criteria: [
    { id: 3, description: 'new', passes: true, evidence: 'real' }] });
  check('new-goal clear: removing external anchor allows fresh re-snapshot',
    d, 'allow', null, { env: { HOME: home } });
}

if (failures > 0) {
  console.log('STOP-GUARD TESTS FAILED: ' + failures);
  process.exit(1);
}
console.log('ALL STOP-GUARD TESTS PASSED (' + caseNo + ' checks)');
