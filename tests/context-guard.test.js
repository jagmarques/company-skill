#!/usr/bin/env node

// Battle-test matrix for hooks/context-guard.js.
// Synthesizes transcript JSONL fixtures, drives the hook with stdin JSON,
// and asserts block/allow. Wired into scripts/check.sh.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hooks', 'context-guard.js');

let failures = 0;
let caseNo = 0;

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-guard-test-'));
}

// Build a single-line JSONL transcript with given usage + model.
function makeTranscript(dir, opts) {
  const msg = {
    role: 'assistant',
    model: opts.model || 'claude-opus-4-8',
    usage: {
      input_tokens: opts.input_tokens || 0,
      cache_read_input_tokens: opts.cache_read || 0,
      cache_creation_input_tokens: opts.cache_create || 0,
    },
  };
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ message: msg }) + '\n');
  return transcriptPath;
}

function runHook(companyDir, transcriptPath, opts) {
  opts = opts || {};
  const input = {
    session_id: opts.session_id !== undefined ? opts.session_id : 'owner-session-1234',
    transcript_path: transcriptPath,
  };
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      env: Object.assign({}, process.env, {
        COMPANY_DIR: companyDir,
        COMPANY_CONTEXT_THRESHOLD: opts.threshold !== undefined ? String(opts.threshold) : '',
        COMPANY_CONTEXT_WINDOW: opts.window !== undefined ? String(opts.window) : '',
      }, opts.env || {}),
      encoding: 'utf8',
      input: JSON.stringify(input),
    });
    return out.trim();
  } catch (e) {
    return 'CRASH:' + e.message;
  }
}

function decide(out) {
  if (out === '') return 'allow';
  if (out.startsWith('CRASH:')) return 'crash';
  try {
    const parsed = JSON.parse(out);
    return parsed.decision === 'block' ? 'block' : 'allow';
  } catch (e) {
    return 'allow';
  }
}

function check(name, companyDir, transcriptPath, expected, opts) {
  caseNo += 1;
  const out = runHook(companyDir, transcriptPath, opts);
  const got = decide(out);
  if (got === 'crash') {
    console.log('FAIL case ' + caseNo + ' (' + name + '): hook crashed: ' + out);
    failures += 1;
  } else if (got !== expected) {
    console.log('FAIL case ' + caseNo + ' (' + name + '): expected ' + expected + ', got ' + got + ' out=' + out);
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' ' + name);
  }
  return out;
}

function setupOwner(companyDir, sessionId) {
  fs.mkdirSync(companyDir, { recursive: true });
  fs.writeFileSync(path.join(companyDir, 'OWNER'), (sessionId || 'owner-session-1234') + '\n');
}

// --- 1M-window model cases ---

// Case 1: 1M model at 60% (600000 used) must BLOCK.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-opus-4-8', input_tokens: 600000 });
  check('1M model 60% blocks', d, t, 'block');
}

// Case 2: 1M model at 12% (120000 used) must ALLOW (the false-fire case with hardcoded 200K).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-opus-4-8', input_tokens: 120000 });
  check('1M model 12% allows (hardcoded-200K false-fire prevented)', d, t, 'allow');
}

// Case 3: 1M model with [1m] in id at 60% must BLOCK.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'some-model-[1m]', input_tokens: 600000 });
  check('1M model via [1m] substring 60% blocks', d, t, 'block');
}

// --- 200K-window model cases ---

// Case 4: 200K model at 60% (120000 used) must BLOCK.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('200K model 60% blocks', d, t, 'block');
}

// Case 5: 200K model at 40% (80000 used) must ALLOW.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 80000 });
  check('200K model 40% allows', d, t, 'allow');
}

// --- Boundary at exactly 50% ---

// Case 6: 200K model exactly at 50% (100000 used) must BLOCK.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 100000 });
  check('200K model exactly 50% blocks', d, t, 'block');
}

// Case 7: 200K model at 49% (98000 used) must ALLOW.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 98000 });
  check('200K model 49% allows', d, t, 'allow');
}

// --- De-loop: RESTART_REQUESTED / state file ---

// Case 8: After a block fires (state file written), same token count must ALLOW (de-loop).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  // First call: must BLOCK and write state file.
  const firstOut = check('200K 60% first block writes state', d, t, 'block');
  // State file must have been written.
  caseNo += 1;
  const stateFile = path.join(d, '.context-guard-state');
  if (!fs.existsSync(stateFile)) {
    console.log('FAIL case ' + caseNo + ' (state file created after block): file missing');
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' state file created after block');
  }
  // Second call with SAME token count: must ALLOW (de-loop).
  check('200K 60% second call same tokens allows (de-loop)', d, t, 'allow');
  // Third call with SAME token count: state is still 120000 (not reset - same tokens don't re-arm).
  // De-loop holds: repeated same-token stops all allow (guard stays out of the way).
  check('200K 60% third call same tokens still allows (de-loop persists)', d, t, 'allow');
}

// Case 9: After de-loop allow, a HIGHER token count still ALLOWS (de-loop releases despite growth).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t1 = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('setup: 60% blocks', d, t1, 'block'); // writes state=120000
  check('de-loop: same tokens allows', d, t1, 'allow'); // state stays 120000 (not reset, 120000 not < 120000)
  // Tokens grew (restart in progress, model doing work): must still ALLOW - de-loop holds.
  const t2 = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 150000 });
  check('after de-loop: higher tokens still allows (de-loop releases despite token growth)', d, t2, 'allow');
}

// Case 9b: De-loop releases after one restart despite token growth (regression test for the bug).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  // Simulate: guard fired at 60% (120000), state file written.
  const stateFile = path.join(d, '.context-guard-state');
  fs.writeFileSync(stateFile, String(120000));
  // Next call at ~70% (140000): with old bug this re-blocked; with fix it must allow.
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 140000 });
  check('de-loop releases after one restart despite token growth', d, t, 'allow');
}

// Case 9c: Re-arm: after a fire at high tokens, a drop below re-arms (resets to -1), then a new fill blocks again.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t_high = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('re-arm setup: 60% blocks', d, t_high, 'block'); // writes state=120000
  // Simulate context drop after restart (new session re-read at low fill) - 30% (60000).
  const t_low = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 60000 });
  // Low fill = below threshold, exits before de-loop check. State file unchanged.
  check('re-arm: 30% allows (below threshold)', d, t_low, 'allow');
  // Now simulate another fill cycle: guard fires again - state was 120000, used=60000 < 120000, resets to -1.
  // We must manually exercise the re-arm path by calling at high tokens while state=120000.
  // Call at 70% (140000): lastFiredTokens=120000 >= 0, used=140000 not < 120000, so allow (de-loop still holds).
  const t_high2 = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 140000 });
  check('re-arm: higher tokens while state=120000 still allows', d, t_high2, 'allow');
  // Now call with tokens BELOW the recorded fire count to trigger re-arm (state -> -1).
  // Use a call that reaches the de-loop check: must be above threshold (60%) but below 120000.
  // 110000 / 200000 = 55% - below 50% threshold? No - 110000/200000=55% which is above 50% threshold.
  // Used=110000 < lastFiredTokens=120000 -> resets state to -1 -> allow.
  const t_rearm = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 110000 });
  check('re-arm: tokens below fire count resets state to -1', d, t_rearm, 'allow');
  // Subsequent call at high tokens: state=-1, lastFiredTokens=-1, so >= 0 is false -> blocks again.
  const t_refire = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 140000 });
  check('re-arm: after reset, high tokens block again', d, t_refire, 'block');
}

// --- Degrade cases ---

// Case 10: No transcript_path in stdin must ALLOW (no crash).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  caseNo += 1;
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      env: Object.assign({}, process.env, { COMPANY_DIR: d }),
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'owner-session-1234' }),
    }).trim();
    const got = decide(out);
    if (got === 'allow') {
      console.log('ok: case ' + caseNo + ' no transcript_path allows (degrade)');
    } else {
      console.log('FAIL case ' + caseNo + ' (no transcript_path): expected allow, got ' + got);
      failures += 1;
    }
  } catch (e) {
    console.log('FAIL case ' + caseNo + ' (no transcript_path): crashed: ' + e.message);
    failures += 1;
  }
}

// Case 11: Garbled JSONL transcript must ALLOW (no crash).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const tp = path.join(d, 'garbled.jsonl');
  fs.writeFileSync(tp, 'not valid json at all\n{broken:}\n');
  check('garbled transcript allows (degrade)', d, tp, 'allow');
}

// Case 12: Transcript with no usage field must ALLOW.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const tp = path.join(d, 'nousage.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ message: { role: 'assistant', model: 'claude-opus-4-8' } }) + '\n');
  check('transcript no usage allows (degrade)', d, tp, 'allow');
}

// Case 13: Non-existent transcript file must ALLOW.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  check('nonexistent transcript allows (degrade)', d, '/nonexistent/path/transcript.jsonl', 'allow');
}

// Case 14: Garbled stdin JSON must ALLOW (no crash).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  caseNo += 1;
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      env: Object.assign({}, process.env, { COMPANY_DIR: d }),
      encoding: 'utf8',
      input: 'not json at all',
    }).trim();
    const got = decide(out);
    if (got === 'allow') {
      console.log('ok: case ' + caseNo + ' garbled stdin allows (degrade)');
    } else {
      console.log('FAIL case ' + caseNo + ' (garbled stdin): expected allow, got ' + got);
      failures += 1;
    }
  } catch (e) {
    console.log('FAIL case ' + caseNo + ' (garbled stdin): crashed: ' + e.message);
    failures += 1;
  }
}

// --- Session scoping ---

// Case 15: Foreign session (not in OWNER) must ALLOW.
{
  const d = freshDir();
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'OWNER'), 'owner-session-1234\n');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  caseNo += 1;
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      env: Object.assign({}, process.env, { COMPANY_DIR: d }),
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'foreign-session-9999', transcript_path: t }),
    }).trim();
    const got = decide(out);
    if (got === 'allow') {
      console.log('ok: case ' + caseNo + ' foreign session allows');
    } else {
      console.log('FAIL case ' + caseNo + ' (foreign session): expected allow, got ' + got);
      failures += 1;
    }
  } catch (e) {
    console.log('FAIL case ' + caseNo + ' (foreign session): crashed: ' + e.message);
    failures += 1;
  }
}

// Case 16: CANCEL file present must ALLOW even at 60%.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  fs.writeFileSync(path.join(d, 'CANCEL'), '');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('CANCEL present allows even at 60%', d, t, 'allow');
}

// --- Configurable threshold ---

// Case 17: COMPANY_CONTEXT_THRESHOLD=0.30 at 35% (70000/200K) must BLOCK.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 70000 });
  check('THRESHOLD=0.30 at 35% blocks', d, t, 'block', { threshold: '0.30' });
}

// Case 18: COMPANY_CONTEXT_THRESHOLD=50 (percent notation) at 55% must BLOCK.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 110000 });
  check('THRESHOLD=50 percent notation at 55% blocks', d, t, 'block', { threshold: '50' });
}

// Case 19: COMPANY_CONTEXT_WINDOW=200000 override on a [1m] model forces 200K window.
// 250000 tokens on 1M model would be 25% (allow), but with 200K override it is 125% (block).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'some-model-[1m]', input_tokens: 250000 });
  check('WINDOW=200000 override on [1m] model blocks at 125%', d, t, 'block', { window: '200000' });
}

// --- Block reason content ---

// Case 20: Block reason must name the fill percentage and include the restart instruction.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  const out = check('block reason names fill pct and restart instruction', d, t, 'block');
  caseNo += 1;
  if (out.indexOf('60%') === -1) {
    console.log('FAIL case ' + caseNo + ' (block reason pct): expected "60%" in reason, got: ' + out);
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' block reason contains fill pct');
  }
  caseNo += 1;
  if (out.indexOf('restart NOW') === -1 && out.indexOf('restart') === -1) {
    console.log('FAIL case ' + caseNo + ' (block reason restart): restart instruction missing: ' + out);
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' block reason contains restart instruction');
  }
}

// --- Cache token accounting ---

// Case 21: used = sum of all three token fields.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  // 200K window: 40000 + 30000 + 30000 = 100000 = exactly 50% -> block
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 40000, cache_read: 30000, cache_create: 30000 });
  check('cache tokens summed correctly: 40K+30K+30K=100K=50% blocks', d, t, 'block');
}

// --- Coexistence with stop-guard ---

// Case 22: Running context-guard on a session with no .company/criteria.json does not crash.
// (Proves it does not require stop-guard state files.)
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  // No criteria.json written - should not cause a crash (context-guard is independent).
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('no criteria.json does not crash context-guard', d, t, 'block');
}

// Summary
if (failures > 0) {
  console.log('CONTEXT-GUARD TESTS FAILED: ' + failures);
  process.exit(1);
}
console.log('ALL CONTEXT-GUARD TESTS PASSED (' + caseNo + ' checks)');
