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

// Write a session-scoped de-loop state file (new JSON format).
function writeSessionState(companyDir, sid, tokens) {
  fs.writeFileSync(
    path.join(companyDir, '.context-guard-state'),
    JSON.stringify({ sessionId: sid, tokens: tokens })
  );
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

// --- De-loop: debate artifact gating ---

// Helper: write a fresh RESTART_DEBATE_CONFIRMED artifact AFTER the state file.
// Returns the artifact path.
function writeDebateArtifact(companyDir, sessionId, stateFile) {
  // Ensure mtime ordering: write state file first (caller handles that), then artifact.
  // We add a small delay by re-stamping the artifact a moment after the state file.
  const artifactPath = path.join(companyDir, 'RESTART_DEBATE_CONFIRMED');
  const rec = {
    sourceVerifier: 'CONFIRMED',
    devilsAdvocate: 'OK',
    completenessCritic: 'OK',
    sessionId: sessionId || null,
    recordedAtTokensMarker: Date.now(),
  };
  // Write state file first so we can force artifact mtime to be newer.
  // The caller already wrote the state file. We just write the artifact now.
  fs.writeFileSync(artifactPath, JSON.stringify(rec));
  return artifactPath;
}

// Case 8: After a block fires (state file written), same token count BLOCKS without artifact.
// With a fresh artifact -> ALLOW. With same tokens again after allow -> re-arm is set, new fire.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  // First call: must BLOCK and write state file.
  check('200K 60% first block writes state', d, t, 'block');
  // State file must have been written.
  caseNo += 1;
  const stateFile = path.join(d, '.context-guard-state');
  if (!fs.existsSync(stateFile)) {
    console.log('FAIL case ' + caseNo + ' (state file created after block): file missing');
    failures += 1;
  } else {
    console.log('ok: case ' + caseNo + ' state file created after block');
  }
  // Second call with SAME token count and NO artifact: must BLOCK (debate gate).
  check('200K 60% second call same tokens BLOCKS without artifact', d, t, 'block');
  // Write a fresh artifact (after the state file mtime) then call again: must ALLOW.
  writeDebateArtifact(d, 'owner-session-1234', stateFile);
  check('200K 60% after fresh artifact ALLOWS', d, t, 'allow');
}

// Case 9: After a fire, higher tokens also BLOCKS without artifact.
// With a fresh artifact: ALLOWS regardless of token growth (deadlock-safety proof).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t1 = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('setup: 60% blocks', d, t1, 'block'); // writes state=120000
  // Higher tokens, no artifact: must BLOCK (not allow like the old de-loop).
  const t2 = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 150000 });
  check('after fire: higher tokens BLOCKS without artifact', d, t2, 'block');
  // Now write fresh artifact: must ALLOW even though tokens grew (no deadlock).
  const stateFile = path.join(d, '.context-guard-state');
  writeDebateArtifact(d, 'owner-session-1234', stateFile);
  check('after fire: higher tokens ALLOWS with fresh artifact (deadlock-safety)', d, t2, 'allow');
}

// Case 9b: Stale artifact (mtime before state file) -> BLOCK.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const stateFile = path.join(d, '.context-guard-state');
  // Write the artifact FIRST (stale).
  const artifactPath = path.join(d, 'RESTART_DEBATE_CONFIRMED');
  fs.writeFileSync(artifactPath, JSON.stringify({
    sourceVerifier: 'CONFIRMED', devilsAdvocate: 'OK', completenessCritic: 'OK',
    sessionId: 'owner-session-1234', recordedAtTokensMarker: Date.now(),
  }));
  // Then write state file AFTER (making artifact mtime older than state mtime).
  fs.writeFileSync(stateFile, String(120000));
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 140000 });
  check('stale artifact (mtime before state file) BLOCKS', d, t, 'block');
}

// Case 9c: Artifact for a different session -> BLOCK.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const stateFile = path.join(d, '.context-guard-state');
  fs.writeFileSync(stateFile, String(120000));
  // Artifact with a different session id (written after state file).
  const artifactPath = path.join(d, 'RESTART_DEBATE_CONFIRMED');
  fs.writeFileSync(artifactPath, JSON.stringify({
    sourceVerifier: 'CONFIRMED', devilsAdvocate: 'OK', completenessCritic: 'OK',
    sessionId: 'different-session-9999', recordedAtTokensMarker: Date.now(),
  }));
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 140000 });
  check('artifact for different session BLOCKS', d, t, 'block');
}

// Case 9d: Re-arm via token drop within the SAME session (used < lastFiredTokens), no artifact.
// Token drop implies a genuine context reset: unconditional re-arm, allow without artifact.
// Uses session-scoped JSON state (new format) so the hook recognizes it as this session's state.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  // Pre-populate session-scoped state: guard fired at 120000 tokens for this session.
  writeSessionState(d, 'owner-session-1234', 120000);
  // Call at 55% (110000) - above threshold, tokens < 120000 -> re-arm, allow.
  const t_rearm = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 110000 });
  check('re-arm: tokens below fire count resets state (no artifact needed)', d, t_rearm, 'allow');
  // Subsequent call at high tokens: state reset, fires again.
  const t_refire = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 140000 });
  check('re-arm: after reset, high tokens block again', d, t_refire, 'block');
}

// Case 9e: Fresh artifact + matching session -> ALLOW + state reset -> next fire re-arms correctly.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('setup: block fires', d, t, 'block'); // state=120000
  const stateFile = path.join(d, '.context-guard-state');
  writeDebateArtifact(d, 'owner-session-1234', stateFile);
  check('fresh artifact matching session ALLOWS', d, t, 'allow'); // state reset to -1, artifact removed
  // Artifact was consumed, next call re-fires.
  check('after artifact consumed, next call blocks again', d, t, 'block');
}

// --- Session-scope fix: cross-session and legacy state must not suppress a fire ---

// (a) Cross-session stale state + 51% -> BLOCK (the live bug regression test).
// Prior session's high-water mark (675148) must NOT release a fresh session at 510000 (51%).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-newsession1');
  // State from a DIFFERENT session (simulates the stale cross-session file left on disk).
  writeSessionState(d, 'owner-session-priorsession', 675148);
  const t = makeTranscript(d, { model: 'claude-opus-4-8', input_tokens: 510000 });
  check('cross-session stale state + 51% BLOCKS (bug-fix regression)', d, t, 'block', {
    session_id: 'owner-session-newsession1',
  });
}

// (b) Legacy bare-number state file + 51% -> BLOCK (self-heals the exact live stale file).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-legacytest1');
  // Write legacy bare-number state (old format, no sessionId field).
  fs.writeFileSync(path.join(d, '.context-guard-state'), '675148');
  const t = makeTranscript(d, { model: 'claude-opus-4-8', input_tokens: 510000 });
  check('legacy bare-number state + 51% BLOCKS (not honored)', d, t, 'block', {
    session_id: 'owner-session-legacytest1',
  });
}

// (c) Same session JSON state: first fire blocks + writes {sessionId,tokens}; second call
// no artifact -> block; fresh artifact -> allow. Proves same-session behavior preserved.
// (Covered by cases 8/9/9e above, but this isolates the happy path with the JSON format.)
{
  const d = freshDir();
  setupOwner(d, 'owner-session-sametest1');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('same-session: first fire blocks', d, t, 'block', { session_id: 'owner-session-sametest1' });
  // State file must be JSON with the correct session id.
  caseNo += 1;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(d, '.context-guard-state'), 'utf8'));
    if (rec.sessionId === 'owner-session-sametest1' && rec.tokens === 120000) {
      console.log('ok: case ' + caseNo + ' same-session: state written as session-scoped JSON');
    } else {
      console.log('FAIL case ' + caseNo + ' (same-session state format): got ' + JSON.stringify(rec));
      failures += 1;
    }
  } catch (e) {
    console.log('FAIL case ' + caseNo + ' (same-session state parse): ' + e.message);
    failures += 1;
  }
  // Second call no artifact: still blocks (debate not recorded).
  check('same-session: second call no artifact BLOCKS', d, t, 'block', {
    session_id: 'owner-session-sametest1',
  });
  // Write fresh artifact then allow.
  const stateFile = path.join(d, '.context-guard-state');
  writeDebateArtifact(d, 'owner-session-sametest1', stateFile);
  check('same-session: fresh artifact ALLOWS', d, t, 'allow', {
    session_id: 'owner-session-sametest1',
  });
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

// Case 16b: CANCEL present AFTER a fire (no artifact) must still ALLOW (escape preserved).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-1234');
  const stateFile = path.join(d, '.context-guard-state');
  fs.writeFileSync(stateFile, String(120000)); // simulate prior fire
  fs.writeFileSync(path.join(d, 'CANCEL'), '');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 140000 });
  check('CANCEL present after fire (no artifact) still ALLOWS (escape preserved)', d, t, 'allow');
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

// --- Null sessionId edge (EDGE B/B2 from critic-pr48.md) ---

// Case 23a: stored sessionId null + incoming session null + 51% -> BLOCK (was the hole).
// Both sides are null; old code: null===null matched, honored high-water, allowed.
// Fix: require both sides to be non-empty strings -> null state is foreign -> first fire -> BLOCK.
{
  const d = freshDir();
  // No OWNER file: legacy gate-all (gate every session).
  fs.mkdirSync(d, { recursive: true });
  // Write state with sessionId:null at a high token count (simulates the edge).
  fs.writeFileSync(
    path.join(d, '.context-guard-state'),
    JSON.stringify({ sessionId: null, tokens: 675148 })
  );
  const t = makeTranscript(d, { model: 'claude-opus-4-8', input_tokens: 510000 });
  // Pass session_id: null via the override (runHook default would send 'owner-session-1234').
  // We need to pass null explicitly. Use execFileSync directly.
  caseNo += 1;
  const inputObj = { transcript_path: t };
  // session_id intentionally omitted -> hook parses null -> incoming sessionId is null.
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      env: Object.assign({}, process.env, { COMPANY_DIR: d }),
      encoding: 'utf8',
      input: JSON.stringify(inputObj),
    }).trim();
    const got = decide(out);
    if (got === 'block') {
      console.log('ok: case ' + caseNo + ' null stored + null incoming + 51% BLOCKS (edge B closed)');
    } else {
      console.log('FAIL case ' + caseNo + ' (null-null edge B): expected block, got ' + got + ' out=' + out);
      failures += 1;
    }
  } catch (e) {
    console.log('FAIL case ' + caseNo + ' (null-null edge B): crashed: ' + e.message);
    failures += 1;
  }
}

// Case 23b: same-session non-null de-loop still allows (regression guard for the fix).
// After a fire with a real string sessionId, a same-session call with fresh artifact -> ALLOW.
{
  const d = freshDir();
  setupOwner(d, 'owner-session-nulledge1');
  const t = makeTranscript(d, { model: 'claude-sonnet-3-5', input_tokens: 120000 });
  check('null-edge: same-session first fire blocks', d, t, 'block', {
    session_id: 'owner-session-nulledge1',
  });
  const stateFile = path.join(d, '.context-guard-state');
  writeDebateArtifact(d, 'owner-session-nulledge1', stateFile);
  check('null-edge: same-session fresh artifact still ALLOWS (de-loop intact)', d, t, 'allow', {
    session_id: 'owner-session-nulledge1',
  });
}

// Case 23c: foreign non-null stored id + different non-null incoming -> BLOCK (original fix).
{
  const d = freshDir();
  setupOwner(d, 'owner-session-nulledge2');
  writeSessionState(d, 'owner-session-other', 675148);
  const t = makeTranscript(d, { model: 'claude-opus-4-8', input_tokens: 510000 });
  check('null-edge: foreign non-null stored id BLOCKS (original fix unbroken)', d, t, 'block', {
    session_id: 'owner-session-nulledge2',
  });
}

// Summary
if (failures > 0) {
  console.log('CONTEXT-GUARD TESTS FAILED: ' + failures);
  process.exit(1);
}
console.log('ALL CONTEXT-GUARD TESTS PASSED (' + caseNo + ' checks)');
