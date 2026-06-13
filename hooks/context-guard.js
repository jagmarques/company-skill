#!/usr/bin/env node

// Context-threshold restart enforcer (productivity guard, fail-OPEN).
// Blocks when token fill >= threshold and forces /company restart.
// NEVER blocks due to parse errors, missing data, or unknown state.
// This is a separate Stop hook - it does NOT modify stop-guard.js.

const fs = require('fs');
const path = require('path');

// Known 1M-context model id substrings (case-insensitive check below).
const KNOWN_1M_SUBSTRINGS = [
  '[1m]',
  'claude-opus-4',
  'claude-opus-4-5',
  'claude-opus-4-8',
];

// Default to the LARGER window when unknown so we never false-fire.
const DEFAULT_WINDOW = 1000000;
const WINDOW_200K = 200000;

function is1MModel(modelId) {
  if (!modelId) return true; // unknown defaults to 1M (fail-open)
  const lower = modelId.toLowerCase();
  for (let i = 0; i < KNOWN_1M_SUBSTRINGS.length; i++) {
    if (lower.indexOf(KNOWN_1M_SUBSTRINGS[i]) !== -1) return true;
  }
  return false;
}

function detectWindow(modelId) {
  // env override wins unconditionally
  const envVal = process.env.COMPANY_CONTEXT_WINDOW;
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (n > 0) return n;
  }
  return is1MModel(modelId) ? DEFAULT_WINDOW : WINDOW_200K;
}

function parseThreshold() {
  const raw = process.env.COMPANY_CONTEXT_THRESHOLD;
  if (!raw) return 0.50;
  const v = parseFloat(raw);
  if (isNaN(v)) return 0.50;
  // accept either fraction (0.5) or percent (50)
  return v > 1 ? v / 100 : v;
}

// Read stdin synchronously (fd 0). Fail-open on any error.
let stdinData = null;
try {
  stdinData = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (e) {
  // garbled or empty stdin: no block
  process.exit(0);
}
if (!stdinData || typeof stdinData !== 'object') process.exit(0);

const sessionId = typeof stdinData.session_id === 'string' ? stdinData.session_id : null;
const transcriptPath = typeof stdinData.transcript_path === 'string' ? stdinData.transcript_path : null;

// Session scoping: same logic as stop-guard.
// Only act for sessions in .company/OWNER. Absent/empty OWNER = gate all (legacy).
const companyDir = process.env.COMPANY_DIR || path.join(process.cwd(), '.company');
const ownerPath = path.join(companyDir, 'OWNER');
const cancelPath = path.join(companyDir, 'CANCEL');

// Respect CANCEL: a cancelled run must not be force-restarted.
try {
  if (fs.existsSync(cancelPath)) process.exit(0);
} catch (e) {
  process.exit(0);
}

// Check session ownership before doing any work.
if (sessionId) {
  try {
    const rawOwners = fs.readFileSync(ownerPath, 'utf8')
      .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    const valid = rawOwners.filter(function (l) { return /^[A-Za-z0-9][A-Za-z0-9._-]{7,}$/.test(l); });
    if (rawOwners.length > 0 && valid.length === rawOwners.length) {
      // Clean OWNER file: only act for listed sessions.
      if (valid.indexOf(sessionId) === -1) process.exit(0);
    }
    // Garbled OWNER or missing OWNER: fall through and gate (fail-closed for scoping).
  } catch (e) {
    // Missing OWNER = legacy state, gate all sessions.
  }
}

// No transcript path means we cannot measure fill: fail-open.
if (!transcriptPath) process.exit(0);

// Parse the transcript JSONL for the last assistant message with usage.
let lastUsage = null;
let lastModelId = null;
try {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    // Claude Code transcript format: each line is an object with a "message" sub-object
    // or directly a message. Handle both.
    const inner = msg.message || msg;
    if (inner && inner.role === 'assistant' && inner.usage) {
      lastUsage = inner.usage;
      if (typeof inner.model === 'string') lastModelId = inner.model;
      else if (typeof msg.model === 'string') lastModelId = msg.model;
      break;
    }
  }
} catch (e) {
  // Unreadable or garbled transcript: fail-open.
  process.exit(0);
}

// No usage found: fail-open.
if (!lastUsage) process.exit(0);

const used =
  (lastUsage.input_tokens || 0) +
  (lastUsage.cache_read_input_tokens || 0) +
  (lastUsage.cache_creation_input_tokens || 0);

const contextWindow = detectWindow(lastModelId);
const threshold = parseThreshold();
const fill = used / contextWindow;

if (fill < threshold) process.exit(0);

// Fill is at or above threshold. Check the de-loop state file before blocking.
// De-loop: record the used-token count when we last fired. If the count has not
// grown since the last fire, allow one stop (the model already emitted the restart
// and is trying to stop - re-blocking would deadlock. Advance the state so the
// NEXT stop that shows more tokens fires again.
const stateDir = path.join(companyDir);
const stateFile = path.join(stateDir, '.context-guard-state');

let lastFiredTokens = -1;
try {
  const raw = fs.readFileSync(stateFile, 'utf8').trim();
  const parsed = parseInt(raw, 10);
  if (!isNaN(parsed)) lastFiredTokens = parsed;
} catch (e) {}

if (lastFiredTokens >= 0) {
  // Fired once already. Re-arm unconditionally when tokens dropped below the fire
  // count (a genuine context reset happened). Otherwise gate on the debate artifact.
  if (used < lastFiredTokens) {
    try { fs.writeFileSync(stateFile, String(-1)); } catch (e) {}
    process.exit(0);
  }

  // Tokens did not drop. Allow the stop only when a fresh debate artifact exists.
  // Fresh = file exists AND its mtime is newer than the state file's mtime.
  // The artifact session must match when both are present.
  const artifactPath = path.join(companyDir, 'RESTART_DEBATE_CONFIRMED');
  let artifactFresh = false;
  try {
    const artifactStat = fs.statSync(artifactPath);
    const stateStat = fs.statSync(stateFile);
    if (artifactStat.mtimeMs > stateStat.mtimeMs) {
      // Check session match: if both have a session id, they must agree.
      let sessionOk = true;
      if (sessionId) {
        try {
          const rec = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
          if (rec.sessionId && rec.sessionId !== sessionId) sessionOk = false;
        } catch (e) {}
      }
      artifactFresh = sessionOk;
    }
  } catch (e) {}

  if (artifactFresh) {
    // Debate recorded. Allow the stop and re-arm for the next cycle.
    try { fs.writeFileSync(stateFile, String(-1)); } catch (e) {}
    // Best-effort: remove the consumed artifact so a stale one cannot release
    // a future fire. Failure is ignored (artifact absence is also safe).
    try { fs.unlinkSync(artifactPath); } catch (e) {}
    process.exit(0);
  }

  // No fresh artifact. Keep blocking until the debate is recorded.
  const pctNow = Math.round((used / detectWindow(lastModelId)) * 100);
  const sessionTagNow = sessionId ? ' [session ' + sessionId + ']' : '';
  console.log(JSON.stringify({
    decision: 'block',
    reason: '[COMPANY] Restart debate not recorded. ' +
      'Run: cat <3-role-verdicts.json> | node scripts/restart-debate.js  ' +
      'then stop. The enforced restart completes only after the debate is recorded.' +
      sessionTagNow,
  }));
  process.exit(0);
}

// First fire: record the count and block once.
try { fs.writeFileSync(stateFile, String(used)); } catch (e) {}

const pct = Math.round(fill * 100);
const threshPct = Math.round(threshold * 100);
const sessionTag = sessionId ? ' [session ' + sessionId + ']' : '';

console.log(JSON.stringify({
  decision: 'block',
  reason: '[COMPANY] Context at ' + pct + '% (>= ' + threshPct + '% threshold). ' +
    'Run /company restart NOW: quiesce in-flight agents, commit their work as draft PRs, ' +
    'refresh STATUS/NEXT, run the restart debate gate, and emit the verified continuation prompt. ' +
    'This is enforced, not advisory - do not continue new work.' + sessionTag
}));
process.exit(0);
