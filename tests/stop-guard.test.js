#!/usr/bin/env node

// Decision-logic matrix for hooks/stop-guard.js. Each case builds a fixture
// state dir, runs the hook with COMPANY_DIR pointed at it, and asserts the
// allow/block decision from the hook's stdout contract: a block prints a
// JSON object with decision "block", an allow prints nothing and exits 0.
// The CI floor (scripts/check.sh) runs this file, so a future edit cannot
// regress the fail-closed behavior with CI still green.

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

// 1. No company state at all: the hook must stay silent (allow).
{
  const d = freshDir();
  check('no state allows', d, 'allow');
}

// 2. CANCEL file: allows the stop AND is consumed so it cannot leak into a later run.
{
  const d = freshDir();
  fs.writeFileSync(path.join(d, 'GOAL.md'), 'goal');
  writeCriteria(d, { criteria: [{ id: 1, description: 'x', passes: false, evidence: null }] });
  fs.writeFileSync(path.join(d, 'CANCEL'), '');
  check('cancel allows', d, 'allow');
  if (fs.existsSync(path.join(d, 'CANCEL'))) {
    console.log('FAIL case ' + caseNo + ' (cancel consumed): CANCEL file survived');
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' cancel file consumed');
  }
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

// 7. passes true with null evidence still blocks: evidence is the contract.
{
  const d = freshDir();
  writeCriteria(d, { criteria: [{ id: 1, description: 'ev gap', passes: true, evidence: null }] });
  check('passes without evidence blocks', d, 'block', 'ev gap');
}

// 8. All passing with evidence allows the stop.
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

// 12. Session scoping: a foreign session passes when OWNER names another session.
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

// 17. Deleting a locked criterion blocks even when everything left passes.
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

// 18. Adding a criterion extends the lock and a fully passing set allows.
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

// 19. No block reason ever hands the model the cancel command.
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

if (failures > 0) {
  console.log('STOP-GUARD TESTS FAILED: ' + failures);
  process.exit(1);
}
console.log('ALL STOP-GUARD TESTS PASSED (' + caseNo + ' checks)');
