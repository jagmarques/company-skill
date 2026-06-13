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

// Hard ceiling: the toggle CANNOT suppress a block at or above this level.
// Default 0.80. Overridable via COMPANY_CONTEXT_HARD_CEILING (fraction or percent).
// If the parsed value is below the soft threshold, it is clamped up to the threshold.
function parseHardCeiling(threshold) {
  const raw = process.env.COMPANY_CONTEXT_HARD_CEILING;
  if (!raw) return 0.80;
  const v = parseFloat(raw);
  if (isNaN(v)) return 0.80;
  // accept either fraction (0.8) or percent (80)
  const frac = v > 1 ? v / 100 : v;
  // hard ceiling must be >= soft threshold
  return frac >= threshold ? frac : threshold;
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
// Resolve companyDir robustly: COMPANY_DIR env wins; else prefer the dir that holds
// a clean OWNER (at least one valid session-id line); fall back to cwd/.company.
// A blank/garbled OWNER does NOT qualify a dir as the active run (BLOCKER-1 fix).
function hasCleanOwner(ownerPath) {
  try {
    const lines = fs.readFileSync(ownerPath, 'utf8')
      .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    return lines.length > 0 &&
      lines.every(function (l) { return /^[A-Za-z0-9][A-Za-z0-9._-]{7,}$/.test(l); });
  } catch (e) { return false; }
}
function resolveCompanyDir() {
  if (process.env.COMPANY_DIR) return process.env.COMPANY_DIR;
  const home = process.env.HOME || '';
  const cwdDir = path.join(process.cwd(), '.company');
  const homeDir = path.join(home, '.company');
  const cwdHasOwner = hasCleanOwner(path.join(cwdDir, 'OWNER'));
  const homeHasOwner = home && hasCleanOwner(path.join(homeDir, 'OWNER'));
  // cwd/.company wins when it has a clean OWNER (project-local run, or both have OWNER).
  if (cwdHasOwner) return cwdDir;
  if (homeHasOwner) return homeDir;
  return cwdDir; // new-run default: preserves original single-project behavior
}
const companyDir = resolveCompanyDir();
const ownerPath = path.join(companyDir, 'OWNER');
const cancelPath = path.join(companyDir, 'CANCEL');

// Respect CANCEL: a cancelled run must not be force-restarted.
try {
  if (fs.existsSync(cancelPath)) process.exit(0);
} catch (e) {
  process.exit(0);
}

// Check session ownership before doing any work.
// Null sessionId with a clean OWNER list = unidentifiable session, fail-open (allow).
// Null sessionId with no OWNER / garbled OWNER = legacy gate-all mode, fall through.
try {
  const rawOwners = fs.readFileSync(ownerPath, 'utf8')
    .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  const valid = rawOwners.filter(function (l) { return /^[A-Za-z0-9][A-Za-z0-9._-]{7,}$/.test(l); });
  if (rawOwners.length > 0 && valid.length === rawOwners.length) {
    // Clean OWNER file: unidentifiable (null) or unlisted session is not a company session.
    if (!sessionId || valid.indexOf(sessionId) === -1) process.exit(0);
  }
  // Garbled OWNER or missing OWNER: fall through and gate (fail-closed for scoping).
} catch (e) {
  // Missing OWNER = legacy state, gate all sessions.
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
const hardCeiling = parseHardCeiling(threshold);
const fill = used / contextWindow;

if (fill < threshold) process.exit(0);

// Per-session toggle: read .company/context-guard-config.json for this session.
// Shape: { "sessions": { "<id>": { "enforceRestart": true|false } } }
// Default (no file, no entry, parse error) = enforceRestart: true (safe default).
// If enforceRestart === false for this session, and fill is BELOW the hard ceiling,
// the toggle suppresses the soft-threshold block. At or above the hard ceiling the
// toggle has no effect and we fall through to block unconditionally.
if (sessionId && fill < hardCeiling) {
  const cfgPath = path.join(companyDir, 'context-guard-config.json');
  try {
    const cfgRaw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(cfgRaw);
    if (cfg && typeof cfg === 'object' &&
        cfg.sessions && typeof cfg.sessions === 'object' &&
        cfg.sessions[sessionId] && typeof cfg.sessions[sessionId] === 'object' &&
        cfg.sessions[sessionId].enforceRestart === false) {
      // Toggle is OFF and below the hard ceiling: allow through without blocking
      process.exit(0);
    }
    // Any other value (true, missing, or unknown) falls through to block
  } catch (e) {
    // File missing or parse error: treat as enforceRestart=true (safe default)
  }
}

// Fill is at or above threshold. Check the de-loop state file before blocking.
// De-loop state is SESSION-SCOPED: stored as JSON { "sessionId": "<id>", "tokens": <n> }.
// A state file from a different session (or a legacy bare-number file) is treated as
// no prior fire for this session (lastFiredTokens = -1). This prevents a prior
// session's high-water mark from suppressing a first-fire in a fresh session.
// Within a session: first fire blocks + writes { sessionId, tokens }; subsequent stops
// with grown tokens require the debate artifact; a token DROP re-arms unconditionally.
const stateFile = path.join(companyDir, '.context-guard-state');

let lastFiredTokens = -1;
try {
  const raw = fs.readFileSync(stateFile, 'utf8').trim();
  // Attempt JSON parse first (session-scoped format).
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) {}
  // Both stored and incoming sessionId must be non-empty strings to honor the high-water.
  // A null on either side means the state is foreign (treat as fresh, block on first fire).
  if (parsed && typeof parsed === 'object' &&
      typeof parsed.sessionId === 'string' && parsed.sessionId !== '' &&
      typeof sessionId === 'string' && sessionId !== '' &&
      parsed.sessionId === sessionId &&
      typeof parsed.tokens === 'number') {
    // State belongs to the current session: honor it.
    lastFiredTokens = parsed.tokens;
  }
  // Null sessionId either side, legacy bare-number, or different session: treat as fresh.
} catch (e) {}

if (lastFiredTokens >= 0) {
  // Fired once already this session. Re-arm unconditionally when tokens dropped below
  // the fire count (a genuine context reset happened). Otherwise gate on the debate artifact.
  if (used < lastFiredTokens) {
    try { fs.writeFileSync(stateFile, JSON.stringify({ sessionId: sessionId, tokens: -1 })); } catch (e) {}
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
    try { fs.writeFileSync(stateFile, JSON.stringify({ sessionId: sessionId, tokens: -1 })); } catch (e) {}
    // Best-effort: remove the consumed artifact so a stale one cannot release
    // a future fire. Failure is ignored (artifact absence is also safe).
    try { fs.unlinkSync(artifactPath); } catch (e) {}
    process.exit(0);
  }

  // No fresh artifact. Keep blocking until the debate is recorded.
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

// First fire for this session: record { sessionId, tokens } and block once.
try {
  fs.writeFileSync(stateFile, JSON.stringify({ sessionId: sessionId, tokens: used }));
} catch (e) {}

const pct = Math.round(fill * 100);
const threshPct = Math.round(threshold * 100);
const ceilPct = Math.round(hardCeiling * 100);
const sessionTag = sessionId ? ' [session ' + sessionId + ']' : '';

// Emit a distinct reason when the hard ceiling is what's enforcing the block.
const atHardCeiling = fill >= hardCeiling;
const reason = atHardCeiling
  ? '[COMPANY] Context at ' + pct + '% (>= ' + ceilPct + '% HARD CEILING). ' +
    'The per-session enforceRestart toggle CANNOT suppress this restart. ' +
    'Run /company restart NOW: quiesce in-flight agents, commit their work as draft PRs, ' +
    'refresh STATUS/NEXT, run the restart debate gate, and emit the verified continuation prompt.' +
    sessionTag
  : '[COMPANY] Context at ' + pct + '% (>= ' + threshPct + '% threshold). ' +
    'Run /company restart NOW: quiesce in-flight agents, commit their work as draft PRs, ' +
    'refresh STATUS/NEXT, run the restart debate gate, and emit the verified continuation prompt. ' +
    'This is enforced, not advisory - do not continue new work.' + sessionTag;

console.log(JSON.stringify({ decision: 'block', reason: reason }));
process.exit(0);
