#!/usr/bin/env node
/**
 * dashboard.js - zero-dependency localhost observability dashboard.
 *
 * Serves one self-contained HTML page (GET /) plus GET /api/state JSON.
 * Reads: ccusage (via npx, cached 60s), the company state dir, and
 * Claude Code transcripts under ~/.claude/projects (model ids, token
 * counts, agent type and description labels and timestamps only, never
 * prompt bodies).
 *
 * Run: node scripts/dashboard.js [--port N] [--company-dir PATH] [--session-id ID]
 * Binds 127.0.0.1 only, hardcoded. Default port derived from session id.
 * Local only. Reads files on this machine, sends nothing anywhere.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

// ---------- args ----------
const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

// MUST-FIX 1: CLAUDE_CODE_SESSION_ID is the primary session id source
const SESSION_ID = argValue('--session-id') ||
  process.env.CLAUDE_CODE_SESSION_ID ||
  process.env.CLAUDE_SESSION_ID ||
  process.env.COMPANY_SESSION_ID ||
  null;

// ---------- deterministic port derivation ----------
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Port 7000-7999, skip 7777 (old default), 8765 and 8901 are well-known in this project
const BLOCKED_PORTS = new Set([7777, 8765, 8901]);
function portFor(id) {
  if (!id) return 7777; // unbound: use 7777, show banner
  let p = 7000 + (fnv1a(id) % 1000);
  if (BLOCKED_PORTS.has(p)) p = 7700;
  return p;
}

const HOST = '127.0.0.1'; // hardcoded loopback, never 0.0.0.0

function resolvePort() {
  const envPort = process.env.COMPANY_DASHBOARD_PORT;
  if (envPort) return Number(envPort);
  const flagPort = argValue('--port');
  if (flagPort) return Number(flagPort);
  return portFor(SESSION_ID);
}
const PORT = resolvePort();

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
  const flag = argValue('--company-dir');
  if (flag) return path.resolve(flag);
  if (process.env.COMPANY_DIR) return path.resolve(process.env.COMPANY_DIR);
  const home = process.env.HOME || os.homedir();
  const cwdDir = path.resolve('.company');
  const homeDir = home ? path.join(home, '.company') : null;
  // Prefer the dir that holds a clean OWNER (real active run) to avoid cwd-drift.
  const cwdHasOwner = hasCleanOwner(path.join(cwdDir, 'OWNER'));
  const homeHasOwner = homeDir && hasCleanOwner(path.join(homeDir, 'OWNER'));
  // cwd/.company wins when it has a clean OWNER (project-local run, or both have OWNER).
  if (cwdHasOwner) return cwdDir;
  if (homeHasOwner) return homeDir;
  return cwdDir; // new-run default: preserves original single-project behavior
}
const COMPANY_DIR = resolveCompanyDir();

// ---------- tiny caches ----------
const FILE_TTL = 2000; // 2s for file reads
const CC_TTL = 60000;  // 60s for ccusage exec results
const fileCache = new Map();

function cachedReadFile(p, maxBytes) {
  const key = p + ':' + (maxBytes || 0);
  const hit = fileCache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < FILE_TTL) return hit.val;
  let val = null;
  try {
    if (maxBytes) val = readTail(p, maxBytes);
    else val = fs.readFileSync(p, 'utf8');
  } catch (_) {
    val = null;
  }
  fileCache.set(key, { ts: now, val });
  return val;
}

function cachedStat(p) {
  const key = 'stat:' + p;
  const hit = fileCache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < FILE_TTL) return hit.val;
  let val = null;
  try {
    val = fs.statSync(p);
  } catch (_) {
    val = null;
  }
  fileCache.set(key, { ts: now, val });
  return val;
}

// Read at most maxBytes from the end of a file, dropping a leading partial line.
function readTail(p, maxBytes) {
  const st = fs.statSync(p);
  const size = st.size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(p, 'r');
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return text;
}

// ---------- ccusage (async, served from cache) ----------
const ccCache = { session: null, daily: null, blocks: null };
const ccPending = { session: false, daily: false, blocks: false };

function getCcusage(sub) {
  const hit = ccCache[sub];
  const now = Date.now();
  if (!hit || now - hit.ts >= CC_TTL) refreshCcusage(sub);
  return hit ? hit.val : null;
}

function refreshCcusage(sub) {
  if (ccPending[sub]) return;
  ccPending[sub] = true;
  execFile(
    'npx',
    ['ccusage@latest', sub, '--json'],
    { timeout: 55000, maxBuffer: 64 * 1024 * 1024 },
    (err, stdout) => {
      ccPending[sub] = false;
      let val = null;
      if (!err) {
        try {
          val = JSON.parse(stdout);
        } catch (_) {
          val = null;
        }
      }
      // Keep stale data rather than overwrite with a failure.
      if (val !== null || !ccCache[sub]) ccCache[sub] = { ts: Date.now(), val };
      else ccCache[sub].ts = Date.now();
    }
  );
}

// ---------- pricing (per MTok list prices) ----------
// Baseline derives from the live session model so it auto-corrects across Fable<->Opus transitions.
// Interim fallback: claude-opus-4-8 (current top tier while Fable 5 is suspended).
const INTERIM_TOP_TIER = 'claude-opus-4-8';

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos'))
    return { i: 10, o: 50, w: 12.5, r: 1, est: false };
  if (m.includes('opus')) {
    if (/opus-4[.-][5-8]/.test(m)) return { i: 5, o: 25, w: 6.25, r: 0.5, est: false };
    return { i: 15, o: 75, w: 18.75, r: 1.5, est: false };
  }
  if (m.includes('sonnet')) return { i: 3, o: 15, w: 3.75, r: 0.3, est: false };
  if (m.includes('haiku')) return { i: 1, o: 5, w: 1.25, r: 0.1, est: false };
  return { i: 10, o: 50, w: 12.5, r: 1, est: true }; // unknown: best known rates
}

function summarizeBreakdowns(breakdowns) {
  const models = [];
  let inT = 0, outT = 0, cw = 0, cr = 0, cost = 0;
  for (const b of breakdowns || []) {
    const row = {
      model: b.modelName || 'unknown',
      input: b.inputTokens || 0,
      output: b.outputTokens || 0,
      cacheCreation: b.cacheCreationTokens || 0,
      cacheRead: b.cacheReadTokens || 0,
      cost: b.cost || 0
    };
    row.total = row.input + row.output + row.cacheCreation + row.cacheRead;
    models.push(row);
    inT += row.input; outT += row.output; cw += row.cacheCreation; cr += row.cacheRead; cost += row.cost;
  }
  return { models, input: inT, output: outT, cacheCreation: cw, cacheRead: cr, total: inT + outT + cw + cr, cost };
}

function computeSavings(win, sessionModel) {
  // Use session model as the top-tier baseline so rates auto-correct when Fable returns.
  const baseline = (sessionModel && sessionModel.trim()) ? sessionModel : INTERIM_TOP_TIER;
  if (!win || !win.models.length) {
    return {
      tieringSaved: null, cacheSaved: null, bestModel: null, estimated: false,
      caveat: 'Approximate: computed from API list prices. On a subscription plan these dollars are notional.'
    };
  }
  let estimated = false;
  const topPrice = priceFor(baseline);
  const hypothetical =
    (win.input * topPrice.i + win.output * topPrice.o +
      win.cacheCreation * topPrice.w + win.cacheRead * topPrice.r) / 1e6;
  let actualCost = 0;
  let cacheSaved = 0;
  for (const m of win.models) {
    const p = priceFor(m.model);
    if (p.est) estimated = true;
    actualCost +=
      (m.input * p.i + m.output * p.o + m.cacheCreation * p.w + m.cacheRead * p.r) / 1e6;
    cacheSaved += (m.cacheRead * (p.i - p.r)) / 1e6;
  }
  const tieringSaved = Math.max(0, hypothetical - actualCost);
  return {
    tieringSaved, cacheSaved, topTierModel: baseline, estimated,
    caveat: 'Approximate: computed from API list prices. On a subscription plan these dollars are notional.'
  };
}

// ---------- transcripts ----------
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// MUST-FIX 2: resolve bound session transcript by globbing ~/.claude/projects/*/<sessionId>.jsonl
// The session id is globally unique across project dirs
function resolveTranscriptPath(sessionId) {
  if (!sessionId) return null;
  try {
    const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(PROJECTS_ROOT, e.name));
    for (const d of dirs) {
      const candidate = path.join(d, sessionId + '.jsonl');
      if (fs.existsSync(candidate)) {
        return { file: candidate, dir: d, id: sessionId };
      }
    }
  } catch (_) {
    return null;
  }
  return null;
}

function cwdSlug() {
  return process.cwd().replace(/[/.]/g, '-');
}

function projectDir() {
  const own = path.join(PROJECTS_ROOT, cwdSlug());
  if (fs.existsSync(own)) return own;
  return null;
}

function newestSessionFile(dir) {
  let best = null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue;
    const st = cachedStat(path.join(dir, e));
    if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { file: path.join(dir, e), id: e.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs };
  }
  return best;
}

function parseLines(text) {
  const out = [];
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) { /* partial or corrupt line */ }
  }
  return out;
}

const ORCH_TAIL = 4 * 1024 * 1024; // read at most 4MB of the orchestrator transcript
const AGENT_TAIL = 2 * 1024 * 1024;

function parseOrchestrator(file) {
  const entries = parseLines(cachedReadFile(file, ORCH_TAIL));
  let sessionModel = null;
  const spawns = new Map(); // tool_use id -> spawn event
  const events = [];
  for (const e of entries) {
    if (e.type === 'assistant' && e.message) {
      if (e.message.model) sessionModel = e.message.model;
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      for (const c of content) {
        if (c.type === 'tool_use' && c.name === 'Agent' && c.input) {
          const ev = {
            kind: 'spawn', ts: e.timestamp || null,
            agentType: c.input.subagent_type || 'agent',
            description: String(c.input.description || '').slice(0, 120)
          };
          spawns.set(c.id, ev);
          events.push(ev);
        }
      }
    } else if (e.type === 'user' && e.message) {
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      for (const c of content) {
        if (c.type === 'tool_result' && spawns.has(c.tool_use_id)) {
          const s = spawns.get(c.tool_use_id);
          events.push({ kind: 'finish', ts: e.timestamp || null, agentType: s.agentType, description: s.description });
        }
      }
    }
  }
  events.reverse(); // newest first
  return { sessionModel, events: events.slice(0, 50) };
}

const agentParseCache = new Map(); // path -> {mtimeMs, val}
function parseAgentDetail(file, st) {
  const hit = agentParseCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.val;
  const entries = parseLines(cachedReadFile(file, AGENT_TAIL));
  let model = null, toolCalls = 0, lastUsage = null;
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message) continue;
    if (e.message.model) model = e.message.model;
    // Track the most-recent usage block only (cache_read accumulates per turn; sum inflates ~73x).
    if (e.message.usage) lastUsage = e.message.usage;
    const content = Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of content) if (c.type === 'tool_use') toolCalls++;
  }
  // Tokens from the last assistant turn: matches computeContextFill's last-turn approach.
  const u = lastUsage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) +
    (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const val = { model, tokens, toolCalls };
  agentParseCache.set(file, { mtimeMs: st.mtimeMs, val });
  return val;
}

// Max age for a file-mtime-based fallback; content-based detection is primary.
// Also used as the stale-tool_use cutoff: tool_use idle longer than this = finished.
const ACTIVE_MS = 900000; // 15 min - stale tool_use agents beyond this are treated as finished

// Read the last ~8 KB of a JSONL to extract the last stop_reason and last timestamp.
// Returns { stopReason: string|null, lastTs: number|null }
function agentTailStatus(jsonlPath) {
  const TAIL = 8192;
  let text = '';
  try {
    const st = fs.statSync(jsonlPath);
    const size = st.size;
    const start = Math.max(0, size - TAIL);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(jsonlPath, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
  } catch (_) { return { stopReason: null, lastTs: null }; }
  let stopReason = null;
  let lastTs = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (!lastTs && obj.timestamp) lastTs = new Date(obj.timestamp).getTime() || null;
    if (!stopReason) {
      const m = obj.message || {};
      if (m.stop_reason) { stopReason = m.stop_reason; }
    }
    if (stopReason && lastTs) break;
  }
  return { stopReason, lastTs };
}

function collectAgents(projDir, sessionId) {
  const subDir = path.join(projDir, sessionId, 'subagents');
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(subDir);
  } catch (_) {
    return out;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!e.endsWith('.meta.json')) continue;
    const id = e.replace(/\.meta\.json$/, '');
    let meta = null;
    try {
      meta = JSON.parse(cachedReadFile(path.join(subDir, e)) || 'null');
    } catch (_) { /* ignore */ }
    if (!meta) continue;
    const jsonl = path.join(subDir, id + '.jsonl');
    const st = cachedStat(jsonl);
    const mtimeMs = st ? st.mtimeMs : 0;
    const ageMs = now - mtimeMs;

    // Status is driven by stop_reason + mtime age.
    // tool_use = agent paused waiting for a tool result. If the file was updated
    // recently (within ACTIVE_MS / 15 min) it is still running. If it has been
    // idle longer than ACTIVE_MS, the agent died or was truncated: treat as finished.
    // end_turn = always finished. Unknown stop_reason falls back to mtime alone.
    const { stopReason, lastTs } = st ? agentTailStatus(jsonl) : { stopReason: null, lastTs: null };
    const isToolUsePaused = stopReason === 'tool_use';
    const isEndTurn = stopReason === 'end_turn';
    // A tool_use agent is only alive when its file was updated within ACTIVE_MS.
    const toolUseActive = isToolUsePaused && ageMs < ACTIVE_MS;
    // active = genuinely running or recently active
    const active = st ? (toolUseActive || (!isEndTurn && stopReason !== null && !isToolUsePaused ? false
      : (stopReason === null && ageMs < ACTIVE_MS))) : false;
    // Status: tool_use + recent -> running; tool_use + stale -> finished (dropped/truncated).
    // end_turn -> finished. unknown -> use mtime window.
    let status;
    if (!st) { status = 'unknown'; }
    else if (isEndTurn) { status = 'finished'; }
    else if (isToolUsePaused && ageMs < ACTIVE_MS) { status = 'running'; }
    else if (isToolUsePaused && ageMs >= ACTIVE_MS) { status = 'finished'; }
    else if (stopReason !== null) { status = 'finished'; }
    else if (ageMs < 30000) { status = 'running'; }
    else if (ageMs < ACTIVE_MS) { status = 'finishing'; }
    else { status = 'finished'; }

    const agent = {
      id: id.replace(/^agent-/, '').slice(0, 8),
      agentType: meta.agentType || 'agent',
      description: String(meta.description || '').slice(0, 120),
      active,
      status,
      mtimeMs
    };
    if (st) {
      // Always populate detail fields so the table shows data for all agents.
      const d = parseAgentDetail(jsonl, st);
      agent.model = d.model;
      agent.tokens = d.tokens;
      agent.toolCalls = d.toolCalls;
      agent.runtimeMs = Math.max(0, st.mtimeMs - st.birthtimeMs);
    }
    out.push(agent);
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// ---------- company dir ----------
function firstNonComment(text) {
  if (!text) return null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t.split(/\s+/)[0];
  }
  return null;
}

function walkBriefings(dir, depth, acc) {
  if (depth > 3) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkBriefings(p, depth + 1, acc);
    else if (/briefing/i.test(e.name)) {
      const st = cachedStat(p);
      if (st) { acc.count++; acc.bytes += st.size; }
    }
  }
}

// compaction + growth tracking (observed while the dashboard runs)
const startState = { checkpointMtime: null, compactions: 0, playbookStart: null, startedAt: Date.now() };

function buildCompanyState() {
  const policyWord = firstNonComment(cachedReadFile(path.join(COMPANY_DIR, 'MODEL_POLICY')));
  const ownerText = cachedReadFile(path.join(COMPANY_DIR, 'OWNER'));
  const ownerCount = ownerText ? ownerText.split('\n').filter((l) => l.trim()).length : 0;
  const halt = !!cachedStat(path.join(COMPANY_DIR, 'CANCEL'));

  let criteria = null;
  try {
    criteria = JSON.parse(cachedReadFile(path.join(COMPANY_DIR, 'criteria.json')) || 'null');
  } catch (_) { /* ignore */ }
  const items = ((criteria && criteria.criteria) || []).map((c) => ({
    id: c.id,
    // Full description sent; client truncates in collapsed view, wraps in expanded view
    description: String(c.description || '').slice(0, 500),
    passes: !!c.passes,
    // Send evidence text (truncated to 400 chars) so expanded view can show it
    evidence: (c.evidence && String(c.evidence).trim()) ? String(c.evidence).slice(0, 400) : null
  }));

  const goal = cachedReadFile(path.join(COMPANY_DIR, 'GOAL.md'));

  const briefings = { count: 0, bytes: 0 };
  walkBriefings(path.join(COMPANY_DIR, 'cycles'), 0, briefings);
  let cycleDirs = 0;
  try {
    cycleDirs = fs.readdirSync(path.join(COMPANY_DIR, 'cycles'), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch (_) { /* ignore */ }

  const playbookSt = cachedStat(path.join(COMPANY_DIR, 'playbook.md'));
  const tasksSt = cachedStat(path.join(COMPANY_DIR, 'active-tasks.md'));
  const ckSt = cachedStat(path.join(COMPANY_DIR, '.checkpoint.md'));

  if (playbookSt && startState.playbookStart === null) startState.playbookStart = playbookSt.size;
  if (ckSt) {
    if (startState.checkpointMtime !== null && ckSt.mtimeMs > startState.checkpointMtime) startState.compactions++;
    startState.checkpointMtime = ckSt.mtimeMs;
  }

  return {
    policy: { policy: policyWord || 'unknown', ownerCount, halt },
    criteria: {
      goal: criteria && criteria.goal ? String(criteria.goal).slice(0, 200) : (goal ? goal.trim().split('\n')[0].slice(0, 200) : null),
      total: items.length,
      passed: items.filter((i) => i.passes).length,
      items
    },
    cycles: {
      cycleDirs,
      briefingCount: briefings.count,
      briefingBytes: briefings.bytes,
      playbookBytes: playbookSt ? playbookSt.size : null,
      playbookGrowthBytes: playbookSt && startState.playbookStart !== null ? playbookSt.size - startState.playbookStart : null,
      activeTasksBytes: tasksSt ? tasksSt.size : null,
      lastCompaction: ckSt ? new Date(ckSt.mtimeMs).toISOString() : null,
      compactionsObserved: startState.compactions
    }
  };
}

// ---------- MUST-FIX 4: context fill using exact guard formula ----------
// Mirror is1MModel from company-context-guard.js EXACTLY (null/unknown -> 1M fail-open)
const KNOWN_1M_SUBSTRINGS = [
  '[1m]',
  'claude-opus-4',
  'claude-opus-4-5',
  'claude-opus-4-8',
];
const DEFAULT_WINDOW = 1000000;
const WINDOW_200K = 200000;

function is1MModel(modelId) {
  // Unknown/null defaults to 1M (fail-open), matching the guard exactly
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  for (let i = 0; i < KNOWN_1M_SUBSTRINGS.length; i++) {
    if (lower.indexOf(KNOWN_1M_SUBSTRINGS[i]) !== -1) return true;
  }
  return false;
}

function detectWindow(modelId) {
  const envVal = process.env.COMPANY_CONTEXT_WINDOW;
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (n > 0) return n;
  }
  return is1MModel(modelId) ? DEFAULT_WINDOW : WINDOW_200K;
}

function parseContextThreshold() {
  const raw = process.env.COMPANY_CONTEXT_THRESHOLD;
  if (!raw) return 0.50;
  const v = parseFloat(raw);
  if (isNaN(v)) return 0.50;
  // Accept either fraction (0.5) or percent (50)
  return v > 1 ? v / 100 : v;
}

// Sum all token fields that count against the context window.
// Matches the Claude Code status line: input + cache_read + cache_creation + output.
function usedTokens(usage) {
  return (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.output_tokens || 0);
}

function computeContextFill(transcriptFile, overrideModel) {
  const threshold = parseContextThreshold();
  if (!transcriptFile) return { used: 0, window: DEFAULT_WINDOW, fill: 0, threshold, modelId: null };
  let lastUsage = null;
  let lastModelId = overrideModel || null;
  try {
    const raw = cachedReadFile(transcriptFile, ORCH_TAIL);
    if (!raw) return { used: 0, window: DEFAULT_WINDOW, fill: 0, threshold, modelId: null };
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const inner = msg.message || msg;
      if (inner && inner.role === 'assistant' && inner.usage) {
        lastUsage = inner.usage;
        if (!lastModelId) {
          if (typeof inner.model === 'string') lastModelId = inner.model;
          else if (typeof msg.model === 'string') lastModelId = msg.model;
        }
        break;
      }
    }
  } catch (_) {
    return { used: 0, window: DEFAULT_WINDOW, fill: 0, threshold, modelId: null };
  }
  if (!lastUsage) return { used: 0, window: DEFAULT_WINDOW, fill: 0, threshold, modelId: lastModelId };
  const used = usedTokens(lastUsage);
  const contextWindow = detectWindow(lastModelId);
  const fill = used / contextWindow;
  return { used, window: contextWindow, fill, threshold, modelId: lastModelId };
}

// ---------- COMPANY.md org chart parser ----------
// Returns { departments: [{ name, lead, roles: [{ name, isLead }] }] }
// Non-roster headings (Priorities, Rules) and HTML-commented blocks are skipped.
const NON_ROSTER_SECTIONS = /^(priorities|rules)$/i;
function parseCompanyMd() {
  // Resolve COMPANY.md: env COMPANY_DIR first, else project cwd, else ~/.company
  const candidates = [
    path.join(COMPANY_DIR, 'COMPANY.md'),
    path.resolve('COMPANY.md'),
  ];
  let text = null;
  for (const p of candidates) {
    text = cachedReadFile(p);
    if (text) break;
  }
  if (!text) return { departments: [] };

  // Strip HTML comment blocks before parsing so commented-out sections are invisible.
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  const departments = [];
  let currentDept = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    // ## heading = new department candidate; strip parenthetical metadata first.
    if (/^##\s+/.test(line)) {
      const raw = line.replace(/^##\s+/, '').trim();
      // BUG #3: extract the declared lead from the heading "(Lead: X)" before stripping it.
      const headingLeadMatch = raw.match(/\(Lead:\s*([^)]+)\)/i);
      const headingLeadName = headingLeadMatch ? headingLeadMatch[1].trim() : null;
      const deptName = raw.replace(/\s*\([^)]*\).*$/, '').trim();
      // BUG #2: skip known non-roster sections (Priorities, Rules).
      if (NON_ROSTER_SECTIONS.test(deptName)) { currentDept = null; continue; }
      currentDept = { name: deptName, lead: null, roles: [], _headingLeadName: headingLeadName };
      departments.push(currentDept);
      continue;
    }
    // Bullet line = a role entry (- **Name** - desc or - Name: desc or - Name, desc)
    if (/^[-*]\s+/.test(line) && currentDept) {
      const body = line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '');
      // BUG #3: detect "Lead: Name" bullet form - name comes AFTER the colon.
      const leadPrefixMatch = body.match(/^lead:\s*([^,\-\n]+)/i);
      let roleName, isExplicitLead;
      if (leadPrefixMatch) {
        // "- Lead: Ana runs growth" -> roleName = "Ana", isExplicitLead = true
        roleName = leadPrefixMatch[1].replace(/\s*\([^)]*\).*$/, '').trim().split(/\s+/)[0];
        isExplicitLead = true;
      } else {
        // Normal "- Name, desc" or "- Name - desc" form
        const nameMatch = body.match(/^([^,\-:]+)/);
        if (!nameMatch) continue;
        roleName = nameMatch[1].replace(/\s*\([^)]*\).*$/, '').trim();
        isExplicitLead = false;
      }
      // CEO is always tier-0, skip from dept roles
      if (/^ceo$/i.test(roleName)) continue;
      const role = { name: roleName, isLead: isExplicitLead };
      currentDept.roles.push(role);
      // First role in dept becomes the lead if none marked explicit and no heading lead declared
      if (!currentDept.lead) currentDept.lead = role;
      if (isExplicitLead && currentDept.lead !== role) currentDept.lead = role;
    }
  }

  // Post-process: apply heading-declared lead (BUG #3) - override first-role default
  for (const dept of departments) {
    if (dept._headingLeadName && dept.roles.length > 0) {
      // Find the role whose name matches the heading lead declaration
      const found = dept.roles.find(r =>
        r.name.toLowerCase() === dept._headingLeadName.toLowerCase()
      );
      if (found) dept.lead = found;
      // If no role matches the heading name exactly, fall back to first role (safe default)
    }
    delete dept._headingLeadName;
  }

  // Remove departments with no roles (BUG #2: also removes phantom sections)
  return { departments: departments.filter(d => d.roles.length > 0) };
}

// ---------- Org tree from COMPANY.md + live agent overlay ----------

// Score how well a live agent name matches a COMPANY.md role name (higher = better)
function roleMatchScore(agentStr, roleName) {
  const a = agentStr.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
  const r = roleName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
  if (a === r) return 100;
  if (a.includes(r) || r.includes(a)) return 60;
  // word-level overlap score
  const aw = new Set(a.split(/\s+/).filter(Boolean));
  const rw = r.split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const w of rw) if (aw.has(w) && w.length > 2) hits++;
  return hits > 0 ? hits * 20 : 0;
}

function buildOrgTree(projDir, sessionId, liveAgents) {
  // Tier 0: orchestrator (CEO)
  const orchNode = { id: 'orchestrator', tier: 0, label: 'CEO', status: 'active', dept: null };

  // Load active-roster.md employee names for mapping
  const rosterText = cachedReadFile(path.join(COMPANY_DIR, 'active-roster.md')) || '';

  // Parse COMPANY.md for the canonical org structure
  const { departments } = parseCompanyMd();

  const nodes = [orchNode];
  const edges = [];

  // Track which live agents have been mapped to named role nodes
  const mappedAgentIds = new Set();

  if (departments.length > 0) {
    // Render the COMPANY.md org chart with live-status overlay
    for (const dept of departments) {
      const lead = dept.lead;
      const leadId = 'dept-' + dept.name.replace(/\s+/g, '-').toLowerCase().slice(0, 30);

      // Map live agents onto this department's roles by name similarity
      // DEPARTMENT-SCOPED: only use agents whose type/desc matches this dept's role names
      const deptRoleNames = dept.roles.map(r => r.name);
      const deptLiveAgents = liveAgents.filter((agent) => {
        if (mappedAgentIds.has(agent.id)) return false;
        const agentStr = (agent.agentType || '') + ' ' + (agent.description || '');
        // Score against any role in this department
        return deptRoleNames.some(rn => roleMatchScore(agentStr, rn) >= 20);
      });

      // Find the best-matched live agent per named role
      const roleAgentMap = new Map(); // roleName -> agent|null
      for (const role of dept.roles) {
        let best = null, bestScore = 0;
        for (const agent of deptLiveAgents) {
          if (mappedAgentIds.has(agent.id)) continue;
          const agentStr = (agent.agentType || '') + ' ' + (agent.description || '');
          const score = roleMatchScore(agentStr, role.name);
          if (score > bestScore) { best = agent; bestScore = score; }
        }
        roleAgentMap.set(role.name, bestScore >= 20 ? best : null);
        if (best && bestScore >= 20) mappedAgentIds.add(best.id);
      }

      // Compute lead node status from whether any dept agent is live
      const anyDeptLive = dept.roles.some(r => roleAgentMap.get(r.name) !== null);
      const leadAgent = roleAgentMap.get(lead.name);
      const leadStatus = leadAgent ? (leadAgent.active ? 'active' : 'idle') : (anyDeptLive ? 'active' : 'idle');

      // Tier-1: department lead node
      nodes.push({
        id: leadId,
        tier: 1,
        label: lead.name,
        dept: dept.name,
        status: leadStatus,
        liveCount: dept.roles.filter(r => roleAgentMap.get(r.name) !== null).length,
        description: 'Lead of ' + dept.name
      });
      // CEO -> dept lead (only CEO connects to leads)
      edges.push({ from: 'orchestrator', to: leadId });

      // Tier-2: other roles in this department (non-lead roles)
      for (const role of dept.roles) {
        if (role === lead) continue; // lead is already tier-1
        const roleId = leadId + '-' + role.name.replace(/\s+/g, '-').toLowerCase().slice(0, 25);
        const agent = roleAgentMap.get(role.name);
        const rStatus = agent ? (agent.active ? (agent.status === 'running' ? 'running' : 'finishing') : 'done') : 'idle';
        nodes.push({
          id: roleId,
          tier: 2,
          dept: dept.name,
          label: role.name,
          employee: role.name,
          status: rStatus,
          currentAction: agent ? agent.description : null,
          model: agent ? (agent.model || null) : null,
          tokens: agent ? (agent.tokens || 0) : 0,
          toolCalls: agent ? (agent.toolCalls || 0) : 0,
          runtimeMs: agent ? (agent.runtimeMs || null) : null
        });
        // Dept lead -> role node (dept-scoped: lead never connects to other dept's roles)
        edges.push({ from: leadId, to: roleId });
      }
    }

    // Unmapped live agents: show under a "General" node beneath CEO
    const unmapped = liveAgents.filter(a => !mappedAgentIds.has(a.id));
    if (unmapped.length > 0) {
      const generalId = 'dept-general';
      const alreadyHasGeneral = nodes.some(n => n.id === generalId);
      if (!alreadyHasGeneral) {
        nodes.push({ id: generalId, tier: 1, label: 'General', dept: 'General', status: 'active', liveCount: unmapped.length });
        edges.push({ from: 'orchestrator', to: generalId });
      }
      for (const agent of unmapped) {
        const nodeId = 'agent-' + agent.id;
        nodes.push({
          id: nodeId, tier: 2, dept: 'General',
          label: (agent.agentType || 'agent').slice(0, 20),
          employee: agent.agentType,
          status: agent.active ? (agent.status === 'running' ? 'running' : 'finishing') : 'done',
          currentAction: agent.description,
          model: agent.model || null,
          tokens: agent.tokens || 0,
          toolCalls: agent.toolCalls || 0,
          runtimeMs: agent.runtimeMs || null
        });
        edges.push({ from: generalId, to: nodeId });
      }
    }
  } else {
    // Fallback: generic dept-based tree when COMPANY.md is missing/unreadable
    const deptMap = new Map();
    for (const agent of liveAgents) {
      const dept = agent.agentType || 'agent';
      if (!deptMap.has(dept)) deptMap.set(dept, []);
      deptMap.get(dept).push(agent);
    }
    for (const [dept, deptAgents] of deptMap) {
      const leadId = 'lead-' + dept;
      nodes.push({ id: leadId, tier: 1, label: dept, dept, status: deptAgents.length > 0 ? 'active' : 'idle', liveCount: deptAgents.length });
      edges.push({ from: 'orchestrator', to: leadId });
      for (const agent of deptAgents) {
        const nodeId = 'agent-' + agent.id;
        nodes.push({
          id: nodeId, tier: 2, dept, label: agent.agentType, employee: agent.agentType,
          status: agent.active ? (agent.status === 'running' ? 'running' : 'finishing') : 'done',
          currentAction: agent.description, model: agent.model || null,
          tokens: agent.tokens || 0, toolCalls: agent.toolCalls || 0, runtimeMs: agent.runtimeMs || null
        });
        edges.push({ from: leadId, to: nodeId });
      }
    }
  }

  const note = 'Logically: CEO delegates to dept leads; leads own their team. Physically the orchestrator spawns all agents.';
  return { nodes, edges, note };
}

// ---------- registry ----------
const REGISTRY_FILE = path.join(COMPANY_DIR, 'dashboard-registry.json');
// Max age before a registry entry is considered stale (5 minutes)
const REGISTRY_STALE_MS = 5 * 60 * 1000;

function readRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessions) {
      // Filter stale entries (lastSeen older than REGISTRY_STALE_MS)
      const now = Date.now();
      for (const [sid, entry] of Object.entries(parsed.sessions)) {
        const ts = entry.lastSeen || entry.startedAt;
        if (ts && (now - new Date(ts).getTime()) > REGISTRY_STALE_MS) {
          delete parsed.sessions[sid];
        }
      }
      return parsed;
    }
  } catch (_) { /* ignore */ }
  return { sessions: {} };
}

function writeRegistryEntry(sessionId, entry) {
  // Atomic read-modify-write: read fresh, update own key, write temp, rename
  const reg = readRegistry();
  reg.sessions[sessionId] = entry;
  const tmp = REGISTRY_FILE + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_2) { /* ignore */ }
  }
}

let ownEntry = null;
if (SESSION_ID) {
  ownEntry = {
    port: PORT,
    pid: process.pid,
    url: 'http://' + HOST + ':' + PORT,
    startedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    sessionId: SESSION_ID
  };
}

function refreshRegistryLastSeen() {
  if (!SESSION_ID || !ownEntry) return;
  ownEntry.lastSeen = new Date().toISOString();
  writeRegistryEntry(SESSION_ID, ownEntry);
}

// Remove own entry only if the stored pid matches this process (prune-own-pid-only).
// A second server for the same session id must not wipe a live entry it does not own.
function pruneOwnRegistryEntry() {
  if (!SESSION_ID) return;
  try {
    const reg = readRegistry();
    const stored = reg.sessions[SESSION_ID];
    // Only remove if the entry still belongs to this pid
    if (!stored || stored.pid !== process.pid) return;
    delete reg.sessions[SESSION_ID];
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
  } catch (_) { /* ignore */ }
}
process.on('exit', pruneOwnRegistryEntry);
process.on('SIGTERM', () => { pruneOwnRegistryEntry(); process.exit(0); });
process.on('SIGINT',  () => { pruneOwnRegistryEntry(); process.exit(0); });

// Heartbeat: every 15s re-assert own entry so a transient prune self-heals.
// unref() so this interval does not keep the process alive on its own.
if (SESSION_ID && ownEntry) {
  const _heartbeat = setInterval(() => {
    if (!SESSION_ID || !ownEntry) return;
    ownEntry.lastSeen = new Date().toISOString();
    // Use the atomic write helper; re-adds the full entry if it went missing
    writeRegistryEntry(SESSION_ID, ownEntry);
  }, 15000);
  _heartbeat.unref();
}

// ---------- per-session restart toggle ----------
// Config file: .company/context-guard-config.json
// Shape: { "sessions": { "<sessionId>": { "enforceRestart": true|false } } }
const TOGGLE_CONFIG = path.join(COMPANY_DIR, 'context-guard-config.json');

function readToggleConfig() {
  try {
    return JSON.parse(fs.readFileSync(TOGGLE_CONFIG, 'utf8') || '{}');
  } catch (_) {
    return { sessions: {} };
  }
}

function writeToggleConfig(cfg) {
  const tmp = TOGGLE_CONFIG + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, TOGGLE_CONFIG);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_2) { /* ignore */ }
  }
}

// Returns the enforceRestart value for a session. Defaults to true when absent.
function getEnforceRestart(sid) {
  if (!sid) return true;
  const cfg = readToggleConfig();
  const s = cfg && cfg.sessions && cfg.sessions[sid];
  if (s && typeof s === 'object' && s.enforceRestart === false) return false;
  return true;
}

// Atomically flip enforceRestart for a session and return the new value.
function flipEnforceRestart(sid) {
  if (!sid) return true;
  const cfg = readToggleConfig();
  if (!cfg.sessions) cfg.sessions = {};
  const current = (cfg.sessions[sid] && cfg.sessions[sid].enforceRestart === false) ? false : true;
  const next = !current;
  cfg.sessions[sid] = Object.assign({}, cfg.sessions[sid] || {}, { enforceRestart: next });
  writeToggleConfig(cfg);
  return next;
}

// ---------- /api/state ----------
function buildState() {
  const daily = getCcusage('daily');
  const session = getCcusage('session');
  const blocks = getCcusage('blocks');

  const todayIso = new Date().toISOString().slice(0, 10);
  let today = null;
  if (daily && Array.isArray(daily.daily)) {
    const row = daily.daily.find((d) => String(d.date || '').startsWith(todayIso)) || daily.daily[daily.daily.length - 1];
    if (row) today = summarizeBreakdowns(row.modelBreakdowns);
  }

  // MUST-FIX 1+2: resolve bound session transcript by global glob
  let orchFile = null;
  let orchDir = null;
  let resolvedSessionId = SESSION_ID;
  let warning = null;

  if (SESSION_ID) {
    const resolved = resolveTranscriptPath(SESSION_ID);
    if (resolved) {
      orchFile = resolved.file;
      orchDir = resolved.dir;
    } else {
      // Bound session transcript not found; fall back to newest
      warning = 'bound session transcript not found, showing newest';
      const projDir = projectDir();
      if (projDir) {
        const newest = newestSessionFile(projDir);
        if (newest) {
          orchFile = newest.file;
          orchDir = path.dirname(newest.file);
          resolvedSessionId = newest.id;
        }
      }
    }
  } else {
    // No session id: show visible unbound banner
    warning = 'unbound - showing shared state';
    const projDir = projectDir();
    if (projDir) {
      const newest = newestSessionFile(projDir);
      if (newest) {
        orchFile = newest.file;
        orchDir = path.dirname(newest.file);
        resolvedSessionId = newest.id;
      }
    }
  }

  let orch = { sessionModel: null, events: [] };
  let agents = [];
  let sessionInfo = null;
  if (orchFile && orchDir && resolvedSessionId) {
    orch = parseOrchestrator(orchFile);
    agents = collectAgents(orchDir, resolvedSessionId);
    const shortId = (SESSION_ID || resolvedSessionId).slice(0, 8);
    sessionInfo = { id: shortId, full: SESSION_ID || resolvedSessionId, bound: !!SESSION_ID };
    if (session && Array.isArray(session.session)) {
      const row =
        session.session.find((s) => String(s.period || '').includes(resolvedSessionId) || String(s.agent || '').includes(resolvedSessionId)) ||
        null;
      if (row) sessionInfo.usage = summarizeBreakdowns(row.modelBreakdowns);
    }
  }

  // MUST-FIX 4: exact guard formula for context fill
  const contextFill = computeContextFill(orchFile, orch.sessionModel);

  let block = null;
  if (blocks && Array.isArray(blocks.blocks)) {
    const b = blocks.blocks.find((x) => x.isActive && !x.isGap);
    if (b) {
      const tc = b.tokenCounts || {};
      const cr = tc.cacheReadInputTokens || 0;
      const denom = (tc.inputTokens || 0) + cr + (tc.cacheCreationInputTokens || 0);
      block = {
        costUSD: b.costUSD || 0,
        burnRate: b.burnRate || null,
        projection: b.projection || null,
        endTime: b.endTime || null,
        cacheHitRate: denom > 0 ? cr / denom : null
      };
    }
  }

  const activeAgents = agents.filter((a) => a.active);

  // Org tree: only active agents appear as live nodes; finished agents are excluded.
  const org = buildOrgTree(orchDir || projectDir(), resolvedSessionId || '', activeAgents);

  refreshRegistryLastSeen();

  return {
    sessionId: SESSION_ID,
    resolvedSessionId,
    warning,
    tokens: { available: !!(daily || session || blocks), today, session: sessionInfo, block },
    savings: computeSavings(today, orch.sessionModel),
    context: { ...contextFill, enforceRestart: getEnforceRestart(SESSION_ID) },
    agents: activeAgents.map((a) => ({
      agentType: a.agentType, model: a.model || null, description: a.description,
      status: a.status, runtimeMs: a.runtimeMs || null, tokens: a.tokens || 0, toolCalls: a.toolCalls || 0
    })),
    org,
    hierarchy: {
      orchestrator: { model: orch.sessionModel, id: sessionInfo ? sessionInfo.id : null },
      children: agents.slice(0, 60).map((a) => ({ id: a.id, agentType: a.agentType, description: a.description, active: a.active }))
    },
    feed: orch.events,
    sessionModel: orch.sessionModel,
    ...buildCompanyState()
  };
}

// inject sessionModel into policy after build
function stateJson() {
  const s = buildState();
  s.policy.sessionModel = s.sessionModel || null;
  delete s.sessionModel;
  return JSON.stringify(s);
}

// ---------- page ----------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Company dashboard</title>
<style>
:root {
  --bg: #f8f7f4;
  --surface: #f5f4f1;
  --line: #d1d9e0;
  --text: #1f2328;
  --dim: #59636e;
  --accent: #1f883d;
  --red: #cf222e;
  --amber: #9a6700;
  --purple: #8250df;
  --cyan: #0969da;
  --hover: #eeecea;
  --radius-card: 18px;
  --radius-pill: 100px;
  --radius-menu: 10px;
  --band: #0a0a0a;
  --band-border: rgba(255,255,255,0.1);
  --font: 'Inter', -apple-system, system-ui, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 15px; line-height: 1.5; }
.wrap { max-width: 72rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
h2 { font-size: 13px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.75rem; }
.mono { font-family: var(--font-mono); }
.muted { color: var(--dim); }
.topline { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1.5rem; }
.stats { display: flex; flex-wrap: wrap; gap: 2.5rem; margin-bottom: 1rem; }
.stat { min-width: 9rem; }
.stat .label { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
.stat b { font-family: var(--font-mono); font-size: 22px; font-weight: 600; display: block; margin-top: 0.15rem; }
.stat .sub { font-size: 12px; color: var(--dim); }
.splitbar { display: flex; height: 8px; border-radius: var(--radius-pill); overflow: hidden; background: var(--hover); margin: 0.5rem 0 0.35rem; }
.splitbar span { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 1rem; font-size: 12px; color: var(--dim); }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.35rem; }
.caveat { font-size: 12px; color: var(--dim); margin-top: 0.5rem; }
.band { background: var(--band); border: 1px solid var(--band-border); color: #d6d9dd; border-radius: var(--radius-menu); padding: 0.6rem 1rem; display: flex; flex-wrap: wrap; gap: 1.75rem; font-size: 13px; margin: 1.5rem 0; }
.band b { color: #fff; font-weight: 600; }
.band .halt { color: var(--red); font-weight: 700; }
.band .warn { color: #e3b341; font-weight: 600; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 1.5rem; margin-bottom: 1.5rem; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); font-weight: 600; padding: 0 0.75rem 0.5rem 0; border-bottom: 1px solid var(--line); }
td { padding: 0.5rem 0.75rem 0.5rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
.card table.center th, .card table.center td { text-align: center; }
.pill { display: inline-block; border-radius: var(--radius-pill); padding: 0.1rem 0.6rem; font-size: 12px; font-weight: 600; }
.pill.run { background: rgba(31,136,61,0.1); color: var(--accent); }
.pill.fin { background: var(--hover); color: var(--dim); }
.pill.warn { background: rgba(154,103,0,0.12); color: var(--amber); }
.empty { color: var(--dim); font-size: 13.5px; padding: 0.5rem 0; }
.feed { font-size: 13px; max-height: 22rem; overflow-y: auto; }
.feed .row { border-bottom: 1px solid var(--line); }
.feed .row:last-child { border-bottom: none; }
.feed-header { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.3rem 0; cursor: pointer; width: 100%; background: none; border: none; text-align: left; font-size: 13px; font-family: inherit; color: inherit; }
.feed-header:hover { background: var(--hover); }
.feed .ts { font-family: var(--font-mono); color: var(--dim); white-space: nowrap; font-size: 12px; flex-shrink: 0; }
.feed .kind { font-weight: 600; width: 3.5rem; flex-shrink: 0; }
.feed .kind.spawn { color: var(--cyan); }
.feed .kind.finish { color: var(--accent); }
.feed-bullet { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feed-caret { font-size: 11px; color: var(--dim); flex-shrink: 0; padding-left: 0.5rem; }
.feed-detail { padding: 0.3rem 0 0.5rem 1.25rem; font-size: 12.5px; white-space: normal; word-break: break-word; color: var(--dim); }
.ctx-card { margin-top: 2.5rem; }
.ctx-gauge-wrap { position: relative; height: 10px; border-radius: var(--radius-pill); overflow: visible; background: var(--hover); margin: 1.25rem 0 2rem; }
.ctx-gauge-bar { position: absolute; left: 0; top: 0; height: 100%; border-radius: var(--radius-pill); transition: width 0.3s; }
.ctx-gauge-bar.green { background: var(--accent); }
.ctx-gauge-bar.amber { background: #d4a017; }
.ctx-gauge-bar.red { background: var(--red); }
.ctx-tick { position: absolute; top: -4px; width: 2px; height: 18px; background: var(--red); border-radius: 1px; }
.ctx-tick-label { position: absolute; top: 17px; font-size: 11px; color: var(--red); white-space: nowrap; transform: translateX(-50%); font-family: var(--font-mono); }
.ctx-row { display: flex; align-items: baseline; gap: 1rem; margin-top: 0.5rem; }
.ctx-pct { font-size: 22px; font-weight: 700; font-family: var(--font-mono); }
.ctx-pct.green { color: var(--accent); }
.ctx-pct.amber { color: var(--amber); }
.ctx-pct.red { color: var(--red); }
.progress { height: 8px; background: var(--hover); border-radius: var(--radius-pill); overflow: hidden; margin: 0.5rem 0 0.5rem; }
.progress span { display: block; height: 100%; background: var(--accent); }
.crit { display: flex; gap: 0.6rem; padding: 0.25rem 0; font-size: 13.5px; align-items: baseline; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line); flex-shrink: 0; position: relative; top: 1px; }
.dot.pass { background: var(--accent); }
.crit-toggle { background: none; border: none; cursor: pointer; color: var(--cyan); font-size: 13px; padding: 0.2rem 0.5rem 0.2rem 0; margin-top: 0.25rem; display: flex; align-items: center; gap: 0.3rem; }
.crit-toggle:hover { text-decoration: underline; }
.kv { display: flex; flex-wrap: wrap; gap: 2rem; font-size: 13.5px; }
.kv div span { display: block; font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
.kv div b { font-family: var(--font-mono); font-weight: 600; }
footer { margin-top: 2rem; font-size: 12.5px; color: var(--dim); border-top: 1px solid var(--line); padding-top: 1rem; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }
.tree-card { position: relative; }
.tree-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
.tree-controls { display: flex; gap: 0.5rem; }
.tree-btn { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; padding: 0.2rem 0.5rem; font-size: 12px; color: var(--dim); }
.tree-btn:hover { background: var(--hover); }
.tree-container { overflow: hidden; border-radius: 12px; background: #fafaf9; border: 1px solid var(--line); position: relative; }
.tree-svg-wrap { overflow: hidden; cursor: grab; user-select: none; }
.tree-svg-wrap:active { cursor: grabbing; }
#tree { display: block; width: 100%; }
.tree-note { font-size: 12px; color: var(--dim); margin-top: 0.5rem; font-style: italic; }
.node-detail { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 1rem; margin-top: 0.75rem; font-size: 13px; }
.node-detail h3 { font-size: 13px; font-weight: 600; margin-bottom: 0.5rem; }
.nd-row { display: flex; gap: 0.5rem; padding: 0.15rem 0; }
.nd-label { font-size: 12px; color: var(--dim); width: 5.5rem; flex-shrink: 0; }
.nd-val { font-family: var(--font-mono); font-size: 12px; }
@keyframes activePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
@media (max-width: 760px) { .stats { gap: 1.5rem; } }
.toggle-on { background: rgba(31,136,61,0.1) !important; border-color: var(--accent) !important; color: var(--accent) !important; font-weight: 600; }
.toggle-off { background: var(--hover) !important; color: var(--dim) !important; }
</style>
</head>
<body>
<div class="wrap">
  <div class="topline">
    <h1>Company dashboard</h1>
    <span class="muted mono" id="updated">connecting</span>
  </div>

  <div id="unbound-banner" style="display:none;background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:0.5rem 1rem;margin-bottom:1rem;font-size:13px;color:#856404;font-weight:600;"></div>

  <section id="header-strip">
    <div class="stats" id="stats"></div>
    <div class="splitbar" id="splitbar"></div>
    <div class="legend" id="legend"></div>
    <div class="caveat" id="caveat"></div>
  </section>

  <div class="card ctx-card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
      <h2 style="margin-bottom:0">Context fill</h2>
      <button id="restart-toggle-btn" style="display:none;background:none;border:1px solid var(--line);border-radius:6px;cursor:pointer;padding:0.2rem 0.75rem;font-size:12px;color:var(--dim);white-space:nowrap;" title="Enable or disable the auto-restart block at the context threshold"></button>
    </div>
    <div id="ctx-fill"></div>
  </div>

  <div class="band" id="policy-band"></div>

  <div class="card">
    <h2>Active agents</h2>
    <div id="agents"></div>
  </div>

  <div class="card tree-card" id="tree-card">
    <div class="tree-header">
      <h2 style="margin-bottom:0">Company delegation tree</h2>
      <div class="tree-controls">
        <button class="tree-btn" id="zoom-in">+</button>
        <button class="tree-btn" id="zoom-out">-</button>
        <button class="tree-btn" id="zoom-reset">reset</button>
        <button class="tree-btn" id="tree-fullscreen">fullscreen</button>
      </div>
    </div>
    <div class="tree-container" id="tree-container">
      <div class="tree-svg-wrap" id="tree-svg-wrap">
        <svg id="tree" preserveAspectRatio="xMidYMin meet"></svg>
      </div>
    </div>
    <div id="node-detail"></div>
    <div class="tree-note" id="tree-note"></div>
  </div>

  <div class="card">
    <h2>Interaction feed</h2>
    <div class="feed" id="feed"></div>
  </div>

  <div class="card">
    <h2>Criteria progress</h2>
    <div id="criteria"></div>
  </div>

  <div class="card">
    <h2>Cycles and memory</h2>
    <div id="cycles"></div>
  </div>

  <footer>
    <span id="burn" class="mono"></span>
    <span>Local only. Reads files on this machine, binds 127.0.0.1, sends nothing anywhere.</span>
  </footer>
</div>

<script>
'use strict';
const COLORS = ['#1f883d', '#8250df', '#0969da', '#bc4c00', '#59636e'];
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const fmtTok = (n) => {
  if (n === null || n === undefined) return '?';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};
const fmtUsd = (n) => (n === null || n === undefined) ? '?' : '$' + n.toFixed(2);
const fmtDur = (ms) => {
  if (!ms && ms !== 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};
const fmtBytes = (n) => {
  if (n === null || n === undefined) return '?';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
};
const shortModel = (m) => m ? String(m).replace(/^claude-/, '') : '?';
// Human-readable model label: "Opus 4.8 (1M context)" style.
// Keep in sync with the server-side humanizeModel() in dashboard.js.
function humanizeModel(modelId) {
  if (!modelId) return '?';
  const m = String(modelId).toLowerCase();
  let name;
  if (m.includes('fable') || m.includes('mythos')) name = 'Fable 5';
  else if (m.includes('opus-4-8')) name = 'Opus 4.8';
  else if (m.includes('opus-4-5')) name = 'Opus 4.5';
  else if (m.includes('opus-4')) name = 'Opus 4';
  else if (m.includes('sonnet-4')) name = 'Sonnet 4';
  else if (m.includes('sonnet-3-7')) name = 'Sonnet 3.7';
  else if (m.includes('sonnet-3-5')) name = 'Sonnet 3.5';
  else if (m.includes('sonnet')) name = 'Sonnet';
  else if (m.includes('haiku')) name = 'Haiku';
  else name = modelId.replace(/^claude-/, '');
  // 1M window: ids containing [1m] or known opus-4 family
  const is1M = m.includes('[1m]') || m.includes('claude-opus-4') ||
    m.includes('fable') || m.includes('mythos');
  const win = is1M ? '1M context' : '200K context';
  return name + ' (' + win + ')';
}

function renderHeader(s) {
  const stats = $('stats');
  stats.replaceChildren();
  const add = (label, value, sub) => {
    const d = el('div', 'stat');
    d.appendChild(el('div', 'label', label));
    d.appendChild(el('b', null, value));
    if (sub) d.appendChild(el('div', 'sub', sub));
    stats.appendChild(d);
  };
  const t = s.tokens || {};
  if (!t.available) {
    add('usage', 'usage data unavailable', 'ccusage not reachable yet');
  } else {
    add('today cost', t.today ? fmtUsd(t.today.cost) : '?', t.today ? fmtTok(t.today.total) + ' tokens' : '');
    const su = t.session && t.session.usage;
    add('session cost', su ? fmtUsd(su.cost) : '?', su ? fmtTok(su.total) + ' tokens' : 'session ' + (t.session && t.session.id || '?'));
    if (s.savings && s.savings.tieringSaved !== null) {
      add('saved by model tiering', fmtUsd(s.savings.tieringSaved) + (s.savings.estimated ? ' est.' : ''), 'vs all-' + shortModel(s.savings.topTierModel) + ' (current top tier)');
      add('saved by prompt caching', fmtUsd(s.savings.cacheSaved) + (s.savings.estimated ? ' est.' : ''), 'cache reads vs full input price');
    }
  }
  const bar = $('splitbar'), legend = $('legend');
  bar.replaceChildren(); legend.replaceChildren();
  const models = (t.today && t.today.models) || [];
  const total = models.reduce((a, m) => a + m.total, 0);
  models.forEach((m, i) => {
    const span = document.createElement('span');
    span.style.width = (total ? (m.total / total) * 100 : 0).toFixed(2) + '%';
    span.style.background = COLORS[i % COLORS.length];
    bar.appendChild(span);
    const li = el('span');
    const ic = el('i'); ic.style.background = COLORS[i % COLORS.length];
    li.appendChild(ic);
    li.appendChild(document.createTextNode(shortModel(m.model) + ' ' + fmtTok(m.total) + ' ' + fmtUsd(m.cost)));
    legend.appendChild(li);
  });
  $('caveat').textContent = s.savings ? s.savings.caveat : '';
}

function renderBand(s) {
  const band = $('policy-band');
  band.replaceChildren();
  const p = s.policy || {};
  const add = (label, value, cls) => {
    const d = el('span');
    d.appendChild(document.createTextNode(label + ' '));
    d.appendChild(el('b', cls, value));
    band.appendChild(d);
  };
  add('policy', p.policy || '?');
  add('session model', humanizeModel(p.sessionModel));
  add('owners', String(p.ownerCount ?? '?'));
  if (p.halt) band.appendChild(el('span', 'halt', 'HALT REQUESTED'));
  if (s.warning) {
    const w = el('span');
    w.appendChild(el('b', 'warn', s.warning));
    band.appendChild(w);
  }
}

// Contract 4: center all columns via table.center class
function renderAgents(s) {
  const root = $('agents');
  root.replaceChildren();
  const agents = s.agents || [];
  if (!agents.length) { root.appendChild(el('div', 'empty', 'No agents running')); return; }
  const table = el('table', 'center');
  const thead = el('thead'); const hr = el('tr');
  ['agent', 'model', 'task', 'status', 'runtime', 'tokens', 'tool calls'].forEach((h) => {
    hr.appendChild(el('th', null, h));
  });
  thead.appendChild(hr); table.appendChild(thead);
  const tbody = el('tbody');
  for (const a of agents) {
    const tr = el('tr');
    tr.appendChild(el('td', null, a.agentType));
    tr.appendChild(el('td', 'mono', shortModel(a.model)));
    tr.appendChild(el('td', null, a.description));
    const td = el('td'); td.appendChild(el('span', 'pill run', a.status)); tr.appendChild(td);
    tr.appendChild(el('td', 'mono', fmtDur(a.runtimeMs)));
    tr.appendChild(el('td', 'mono', fmtTok(a.tokens)));
    tr.appendChild(el('td', 'mono', String(a.toolCalls)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

// Contract 2: context fill gauge with 50% restart tick
function renderContextFill(s) {
  const root = $('ctx-fill');
  root.replaceChildren();
  const ctx = s.context;

  // Update the toggle button whenever we have a bound session
  const toggleBtn = $('restart-toggle-btn');
  if (toggleBtn && s.sessionId && ctx) {
    const enforce = ctx.enforceRestart !== false;
    toggleBtn.style.display = '';
    toggleBtn.textContent = 'Auto-restart at ' + Math.round((ctx.threshold || 0.5) * 100) + '%: ' + (enforce ? 'ON' : 'OFF');
    toggleBtn.className = enforce ? 'toggle-on' : 'toggle-off';
  } else if (toggleBtn) {
    toggleBtn.style.display = 'none';
  }

  if (!ctx || ctx.used === 0) {
    root.appendChild(el('div', 'muted', 'No transcript usage found'));
    return;
  }
  const pct = (ctx.fill * 100).toFixed(1);
  const threshPct = (ctx.threshold * 100).toFixed(0);
  let colorClass = 'green';
  if (ctx.fill >= ctx.threshold) colorClass = 'red';
  else if (ctx.fill >= 0.4) colorClass = 'amber';

  const wrap = el('div', 'ctx-gauge-wrap');
  const barFill = el('div', 'ctx-gauge-bar ' + colorClass);
  barFill.style.width = Math.min(100, ctx.fill * 100).toFixed(2) + '%';
  wrap.appendChild(barFill);

  const tick = el('div', 'ctx-tick');
  tick.style.left = (ctx.threshold * 100).toFixed(2) + '%';
  wrap.appendChild(tick);
  const tickLabel = el('div', 'ctx-tick-label', 'restart ' + threshPct + '%');
  tickLabel.style.left = (ctx.threshold * 100).toFixed(2) + '%';
  wrap.appendChild(tickLabel);
  root.appendChild(wrap);

  const row = el('div', 'ctx-row');
  row.appendChild(el('span', 'ctx-pct ' + colorClass, pct + '%'));
  row.appendChild(el('span', 'muted', fmtTok(ctx.used) + ' / ' + fmtTok(ctx.window) + ' tokens'));
  if (ctx.modelId) row.appendChild(el('span', 'muted', humanizeModel(ctx.modelId)));
  if (ctx.fill >= ctx.threshold && ctx.enforceRestart !== false) row.appendChild(el('span', 'pill warn', 'restart due'));
  root.appendChild(row);
}

// Set up the toggle button click handler once
let _toggleSetup = false;
function setupRestartToggle() {
  if (_toggleSetup) return;
  _toggleSetup = true;
  const btn = $('restart-toggle-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await fetch('/api/restart-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      // Update button immediately without waiting for poll
      const threshPct = btn.textContent.match(/(\d+)%/) ? btn.textContent.match(/(\d+)%/)[1] : '50';
      const enforce = data.enforceRestart !== false;
      btn.textContent = 'Auto-restart at ' + threshPct + '%: ' + (enforce ? 'ON' : 'OFF');
      btn.className = enforce ? 'toggle-on' : 'toggle-off';
    } catch (_) { /* ignore */ }
    btn.disabled = false;
  });
}

// MUST-FIX 1: visible unbound banner
function renderUnboundBanner(s) {
  const banner = $('unbound-banner');
  if (s.warning) {
    banner.textContent = 'Session: ' + s.warning;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

// Contract 3 + MUST-FIX 5: interactive SVG org tree with diff-update and persisted view state
// View state stored in sessionStorage keyed by session id to avoid cross-tab clobber
let _treeSessionId = null;
const treeView = { vbX: 0, vbY: 0, vbW: 900, vbH: 500, selectedNode: null, isInteracting: false };

function treeStorageKey() {
  return 'companyTree:' + (_treeSessionId || 'unbound');
}

function loadTreeView() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(treeStorageKey()) || '{}');
    if (typeof saved.vbX === 'number') treeView.vbX = saved.vbX;
    if (typeof saved.vbY === 'number') treeView.vbY = saved.vbY;
    if (typeof saved.vbW === 'number') treeView.vbW = saved.vbW;
    if (typeof saved.vbH === 'number') treeView.vbH = saved.vbH;
    if (saved.selectedNode) treeView.selectedNode = saved.selectedNode;
  } catch (_) {}
}

function saveTreeView() {
  try {
    sessionStorage.setItem(treeStorageKey(), JSON.stringify({
      vbX: treeView.vbX, vbY: treeView.vbY, vbW: treeView.vbW, vbH: treeView.vbH,
      selectedNode: treeView.selectedNode
    }));
  } catch (_) {}
}

let _orgNodes = [];
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
}

function nodeColor(status) {
  if (status === 'running') return '#1f883d';
  if (status === 'finishing') return '#0969da';
  if (status === 'done') return '#8250df';
  if (status === 'active') return '#0969da';
  return '#59636e';
}

function nodeFill(status, tier) {
  if (tier === 0) return '#0a0a0a';
  if (status === 'running') return 'rgba(31,136,61,0.12)';
  if (status === 'finishing') return 'rgba(9,105,218,0.10)';
  if (status === 'done') return 'rgba(130,80,223,0.08)';
  if (status === 'active') return 'rgba(9,105,218,0.08)';
  return 'rgba(89,99,110,0.06)';
}

// Compute x/y positions for each node
function layoutTree(org) {
  const nodes = org.nodes || [];
  if (!nodes.length) return { placed: {}, W: 400, H: 100 };
  const W = 900;
  const nodeW = 140, nodeH = 36;
  const tierY = { 0: 40, 1: 130, 2: 240 };
  const placed = {};

  const tier0 = nodes.filter(n => n.tier === 0);
  const tier1 = nodes.filter(n => n.tier === 1);
  const tier2 = nodes.filter(n => n.tier === 2);

  if (tier0.length) placed[tier0[0].id] = { x: W / 2 - nodeW / 2, y: tierY[0] };

  const t1Step = tier1.length > 0 ? Math.max(nodeW + 16, W / tier1.length) : W;
  tier1.forEach((n, i) => {
    placed[n.id] = { x: Math.max(0, t1Step * i + (t1Step - nodeW) / 2), y: tierY[1] };
  });

  // Group tier-2 under their lead
  const byLead = {};
  for (const e of (org.edges || [])) {
    if (!byLead[e.from]) byLead[e.from] = [];
    byLead[e.from].push(e.to);
  }
  let totalH = 320;
  for (const [leadId, childIds] of Object.entries(byLead)) {
    const leadPos = placed[leadId];
    if (!leadPos) continue;
    const lead = nodes.find(n => n.id === leadId);
    if (!lead || lead.tier !== 1) continue;
    const t2children = childIds.filter(cid => {
      const cn = nodes.find(n => n.id === cid);
      return cn && cn.tier === 2;
    });
    const cols = Math.min(3, t2children.length);
    const slotW = Math.max(nodeW + 8, t1Step);
    const groupW = cols * slotW;
    const startX = leadPos.x + nodeW / 2 - groupW / 2;
    t2children.forEach((cid, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const y = tierY[2] + row * (nodeH + 14);
      const x = startX + col * slotW;
      placed[cid] = { x, y };
      if (y + nodeH + 20 > totalH) totalH = y + nodeH + 20;
    });
  }
  for (const n of tier2) {
    if (!placed[n.id]) {
      placed[n.id] = { x: 10, y: tierY[2] };
    }
  }
  return { placed, W, H: Math.max(320, totalH) };
}

function renderTree(s) {
  const org = s.org || { nodes: [], edges: [], note: '' };
  _orgNodes = org.nodes || [];

  if (s.sessionId && !_treeSessionId) {
    _treeSessionId = s.sessionId;
    loadTreeView(); // load persisted view state now that we have a session id
  }

  const svg = $('tree');
  const { placed, W, H } = layoutTree(org);
  const nodeW = 140, nodeH = 36;

  // Initialize natural dimensions once
  if (!svg.dataset.initVb) {
    treeView.vbW = W; treeView.vbH = H;
    svg.setAttribute('viewBox', treeView.vbX + ' ' + treeView.vbY + ' ' + treeView.vbW + ' ' + treeView.vbH);
    svg.setAttribute('height', Math.min(H, 460));
    svg.dataset.initVb = '1';
    svg.dataset.naturalW = W;
    svg.dataset.naturalH = H;
  }

  // Get or create root group for diff-update
  let rootG = svg.getElementById('tree-root');
  if (!rootG) {
    rootG = svgEl('g', { id: 'tree-root' });
    svg.appendChild(rootG);
  }

  // Index existing edges and node groups
  const existingEdges = {};
  for (const line of rootG.querySelectorAll('line[data-edge]')) {
    existingEdges[line.dataset.edge] = line;
  }
  const existingNodes = {};
  for (const g of rootG.querySelectorAll('g[data-nid]')) {
    existingNodes[g.dataset.nid] = g;
  }

  const wantEdges = new Set();
  const wantNodes = new Set();

  // Update edges
  for (const edge of (org.edges || [])) {
    const fp = placed[edge.from], tp = placed[edge.to];
    if (!fp || !tp) continue;
    const key = edge.from + '>' + edge.to;
    wantEdges.add(key);
    const x1 = fp.x + nodeW / 2, y1 = fp.y + nodeH;
    const x2 = tp.x + nodeW / 2, y2 = tp.y;
    let line = existingEdges[key];
    if (!line) {
      line = svgEl('line', { 'data-edge': key, stroke: '#d1d9e0', 'stroke-width': 1 });
      rootG.insertBefore(line, rootG.firstChild);
    }
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  }
  for (const k of Object.keys(existingEdges)) {
    if (!wantEdges.has(k)) existingEdges[k].remove();
  }

  // Update nodes (diff-update in place)
  for (const node of _orgNodes) {
    const pos = placed[node.id];
    if (!pos) continue;
    wantNodes.add(node.id);
    const color = nodeColor(node.status);
    const fill = nodeFill(node.status, node.tier);
    const isSelected = treeView.selectedNode === node.id;
    const label = (node.label || node.id).slice(0, 16);

    let g = existingNodes[node.id];
    if (!g) {
      g = svgEl('g', { 'data-nid': node.id, cursor: 'pointer' });
      g.addEventListener('click', () => {
        treeView.selectedNode = (treeView.selectedNode === node.id) ? null : node.id;
        saveTreeView();
        renderNodeDetail();
      });
      g.appendChild(svgEl('rect', {}));
      g.appendChild(svgEl('text', { 'class': 'nl' }));
      g.appendChild(svgEl('text', { 'class': 'ns' }));
      rootG.appendChild(g);
    }

    const rect = g.querySelector('rect');
    rect.setAttribute('x', pos.x); rect.setAttribute('y', pos.y);
    rect.setAttribute('width', nodeW); rect.setAttribute('height', nodeH);
    rect.setAttribute('rx', 8); rect.setAttribute('fill', fill);
    rect.setAttribute('stroke', isSelected ? color : (node.tier === 0 ? '#0a0a0a' : color));
    rect.setAttribute('stroke-width', isSelected ? 2 : 1);
    rect.style.animation = node.status === 'running' ? 'activePulse 1.5s ease-in-out infinite' : '';

    const textEl = g.querySelector('.nl');
    textEl.setAttribute('x', pos.x + nodeW / 2); textEl.setAttribute('y', pos.y + 16);
    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('fill', node.tier === 0 ? '#fff' : color);
    textEl.setAttribute('font-size', 11); textEl.setAttribute('font-weight', 600);
    textEl.setAttribute('font-family', 'ui-monospace,Menlo,monospace');
    textEl.textContent = label;

    const subEl = g.querySelector('.ns');
    subEl.setAttribute('x', pos.x + nodeW / 2); subEl.setAttribute('y', pos.y + 28);
    subEl.setAttribute('text-anchor', 'middle'); subEl.setAttribute('fill', '#888');
    subEl.setAttribute('font-size', 9);
    subEl.setAttribute('font-family', 'ui-monospace,Menlo,monospace');
    const tierLabel = node.tier === 0 ? 'orchestrator' : (node.tier === 1 ? 'lead' : node.status);
    subEl.textContent = tierLabel;
  }

  // Remove stale nodes
  for (const nid of Object.keys(existingNodes)) {
    if (!wantNodes.has(nid)) existingNodes[nid].remove();
  }

  // Apply view state only when not interacting (MUST-FIX 5)
  if (!treeView.isInteracting) {
    svg.setAttribute('viewBox', treeView.vbX + ' ' + treeView.vbY + ' ' + treeView.vbW + ' ' + treeView.vbH);
  }

  const noteEl = $('tree-note');
  if (noteEl) noteEl.textContent = org.note || '';
}

function renderNodeDetail() {
  const container = $('node-detail');
  if (!container) return;
  container.replaceChildren();
  if (!treeView.selectedNode) return;
  const node = _orgNodes.find(n => n.id === treeView.selectedNode);
  if (!node) return;
  const panel = el('div', 'node-detail');
  panel.appendChild(el('h3', null, node.label || node.id));
  const rows = [
    ['tier', node.tier === 0 ? 'orchestrator' : (node.tier === 1 ? 'lead' : 'worker')],
    ['status', node.status || '?'],
    ['dept', node.dept || '-'],
    ['model', node.model || '-'],
    ['tokens', fmtTok(node.tokens)],
    ['tool calls', String(node.toolCalls || 0)],
    ['runtime', node.runtimeMs ? fmtDur(node.runtimeMs) : '-'],
  ];
  if (node.task) rows.push(['task', node.task]);
  if (node.surfaces) rows.push(['surfaces', node.surfaces]);
  if (node.currentAction) rows.push(['action', node.currentAction.slice(0, 120)]);
  for (const [label, val] of rows) {
    const row = el('div', 'nd-row');
    row.appendChild(el('span', 'nd-label', label));
    row.appendChild(el('span', 'nd-val', val));
    panel.appendChild(row);
  }
  container.appendChild(panel);
}

// Set up zoom/pan/fullscreen interactions once
let _treeInteractionsSetup = false;
function setupTreeInteractions() {
  if (_treeInteractionsSetup) return;
  _treeInteractionsSetup = true;
  const svg = $('tree');
  const wrap = $('tree-svg-wrap');

  // Zoom floor = reset/natural dimensions (MIN_ZOOM == reset scale; user cannot zoom out past it)
  function minZoomW() { return parseFloat(svg.dataset.naturalW) || 900; }
  function minZoomH() { return parseFloat(svg.dataset.naturalH) || 500; }

  function clampToFloor() {
    // Clamp vbW/vbH to at most the natural (reset) dimensions
    if (treeView.vbW > minZoomW()) {
      const cx = treeView.vbX + treeView.vbW / 2;
      const cy = treeView.vbY + treeView.vbH / 2;
      treeView.vbW = minZoomW(); treeView.vbH = minZoomH();
      treeView.vbX = cx - treeView.vbW / 2; treeView.vbY = cy - treeView.vbH / 2;
    }
  }

  // Mouse wheel zoom (MUST-FIX 5: set isInteracting to suppress poll re-apply)
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    treeView.isInteracting = true;
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    const cx = treeView.vbX + treeView.vbW / 2;
    const cy = treeView.vbY + treeView.vbH / 2;
    treeView.vbW *= factor; treeView.vbH *= factor;
    treeView.vbX = cx - treeView.vbW / 2; treeView.vbY = cy - treeView.vbH / 2;
    // Enforce zoom floor: cannot zoom out beyond reset/natural size
    clampToFloor();
    svg.setAttribute('viewBox', treeView.vbX + ' ' + treeView.vbY + ' ' + treeView.vbW + ' ' + treeView.vbH);
    saveTreeView();
    clearTimeout(wrap._iTimer);
    wrap._iTimer = setTimeout(() => { treeView.isInteracting = false; }, 300);
  }, { passive: false });

  // Pan by drag
  let ds = null, dvs = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('g[data-nid]')) return;
    ds = { x: e.clientX, y: e.clientY };
    dvs = { x: treeView.vbX, y: treeView.vbY };
    treeView.isInteracting = true;
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!ds) return;
    const r = svg.getBoundingClientRect();
    const sx = treeView.vbW / r.width, sy = treeView.vbH / r.height;
    treeView.vbX = dvs.x + (ds.x - e.clientX) * sx;
    treeView.vbY = dvs.y + (ds.y - e.clientY) * sy;
    svg.setAttribute('viewBox', treeView.vbX + ' ' + treeView.vbY + ' ' + treeView.vbW + ' ' + treeView.vbH);
    saveTreeView();
  });
  const endDrag = () => {
    ds = null;
    clearTimeout(wrap._iTimer);
    wrap._iTimer = setTimeout(() => { treeView.isInteracting = false; }, 300);
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  $('zoom-in').addEventListener('click', () => {
    const cx = treeView.vbX + treeView.vbW / 2, cy = treeView.vbY + treeView.vbH / 2;
    treeView.vbW *= 0.8; treeView.vbH *= 0.8;
    treeView.vbX = cx - treeView.vbW / 2; treeView.vbY = cy - treeView.vbH / 2;
    svg.setAttribute('viewBox', treeView.vbX + ' ' + treeView.vbY + ' ' + treeView.vbW + ' ' + treeView.vbH);
    saveTreeView();
  });
  $('zoom-out').addEventListener('click', () => {
    const cx = treeView.vbX + treeView.vbW / 2, cy = treeView.vbY + treeView.vbH / 2;
    treeView.vbW *= 1.25; treeView.vbH *= 1.25;
    treeView.vbX = cx - treeView.vbW / 2; treeView.vbY = cy - treeView.vbH / 2;
    // Enforce zoom floor: MIN_ZOOM == reset scale, cannot zoom out past it
    clampToFloor();
    svg.setAttribute('viewBox', treeView.vbX + ' ' + treeView.vbY + ' ' + treeView.vbW + ' ' + treeView.vbH);
    saveTreeView();
  });
  $('zoom-reset').addEventListener('click', () => {
    // Reset = natural (floor) dimensions; this is also the minimum zoom level
    const nW = minZoomW();
    const nH = minZoomH();
    treeView.vbX = 0; treeView.vbY = 0; treeView.vbW = nW; treeView.vbH = nH;
    svg.setAttribute('viewBox', '0 0 ' + nW + ' ' + nH);
    saveTreeView();
  });
  $('tree-fullscreen').addEventListener('click', () => {
    const card = $('tree-card');
    if (!document.fullscreenElement) card.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });
}

// Per-feed-item expand: sessionStorage set of expanded item keys, keyed per session
function feedStorageKey() {
  return 'feedExpanded:' + (_treeSessionId || 'unbound');
}

function loadFeedExpanded() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(feedStorageKey()) || '[]'));
  } catch (_) { return new Set(); }
}

function saveFeedExpanded(set) {
  try { sessionStorage.setItem(feedStorageKey(), JSON.stringify([...set])); } catch (_) {}
}

let _lastFeed = null;

// Build a stable per-item key from ts + kind + agentType (no id on feed events)
function feedItemKey(e, idx) {
  return (e.ts || '') + ':' + (e.kind || '') + ':' + (e.agentType || '') + ':' + idx;
}

function renderFeed(s) {
  const root = $('feed');
  root.replaceChildren();
  const feed = s.feed || [];
  _lastFeed = feed;
  if (!feed.length) {
    root.appendChild(el('div', 'empty', 'No spawn or finish events in the current transcript tail'));
    return;
  }
  const expanded = loadFeedExpanded();
  for (let idx = 0; idx < feed.length; idx++) {
    const e = feed[idx];
    const key = feedItemKey(e, idx);
    const isOpen = expanded.has(key);

    const row = el('div', 'row');

    // Collapsed header: timestamp + kind badge + truncated bullet + caret
    const header = el('button', 'feed-header');
    header.appendChild(el('span', 'ts', e.ts ? new Date(e.ts).toLocaleTimeString() : '?'));
    header.appendChild(el('span', 'kind ' + e.kind, e.kind));
    const bullet = el('span', 'feed-bullet');
    bullet.textContent = (e.agentType || '') + ': ' + (e.description || '');
    header.appendChild(bullet);
    const caret = el('span', 'feed-caret');
    caret.textContent = isOpen ? 'v' : '>';
    header.appendChild(caret);
    row.appendChild(header);

    // Expanded detail: full text, wrapping freely
    if (isOpen) {
      const detail = el('div', 'feed-detail');
      detail.textContent = (e.agentType || '') + ': ' + (e.description || '');
      row.appendChild(detail);
    }

    header.addEventListener('click', () => {
      // Read fresh from storage so concurrent tabs don't clobber each other
      const current = loadFeedExpanded();
      if (current.has(key)) current.delete(key);
      else current.add(key);
      saveFeedExpanded(current);
      // Re-render only the feed section using cached state
      if (_lastFeed !== null) renderFeed({ feed: _lastFeed });
    });

    root.appendChild(row);
  }
}

// Per-criterion expand: sessionStorage set of expanded item ids, keyed per session
function criteriaStorageKey() {
  return 'critExpanded:' + (_treeSessionId || 'unbound');
}

function loadCritExpanded() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(criteriaStorageKey()) || '[]'));
  } catch (_) { return new Set(); }
}

function saveCritExpanded(set) {
  try { sessionStorage.setItem(criteriaStorageKey(), JSON.stringify([...set])); } catch (_) {}
}

let _lastCriteria = null;

function renderCriteria(s) {
  const root = $('criteria');
  root.replaceChildren();
  const c = s.criteria || {};
  _lastCriteria = c;
  if (!c.total) { root.appendChild(el('div', 'empty', 'No criteria.json found')); return; }

  const evCount = (c.items || []).filter(i => i.evidence).length;
  root.appendChild(el('div', 'muted', (c.passed || 0) + '/' + c.total + ' passing - ' + evCount + ' with evidence'));

  const bar = el('div', 'progress');
  const fill = el('span');
  fill.style.width = ((c.passed / c.total) * 100).toFixed(2) + '%';
  bar.appendChild(fill);
  root.appendChild(bar);

  // Per-item collapsible list: each criterion is a short one-line bullet
  const expanded = loadCritExpanded();
  const list = el('div');
  list.style.marginTop = '0.5rem';

  for (const item of c.items || []) {
    const itemId = String(item.id);
    const isOpen = expanded.has(itemId);

    const wrap = el('div');
    wrap.style.borderBottom = '1px solid var(--line)';
    wrap.style.padding = '0.2rem 0';

    // Collapsed row: dot + number + truncated title + toggle caret
    const header = el('button');
    header.style.cssText = 'display:flex;align-items:center;gap:0.5rem;background:none;border:none;cursor:pointer;width:100%;text-align:left;padding:0.25rem 0;font-size:13.5px;';
    const dot = el('span', 'dot' + (item.passes ? ' pass' : ''));
    dot.style.flexShrink = '0';
    header.appendChild(dot);
    const titleSpan = el('span');
    titleSpan.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleSpan.textContent = itemId + '. ' + item.description;
    header.appendChild(titleSpan);
    const caret = el('span', 'muted');
    caret.style.cssText = 'font-size:11px;flex-shrink:0;padding-left:0.5rem;';
    caret.textContent = isOpen ? 'v' : '>';
    header.appendChild(caret);
    wrap.appendChild(header);

    // Expanded detail: full description + evidence, wrapping freely
    if (isOpen) {
      const detail = el('div');
      detail.style.cssText = 'padding:0.4rem 0 0.5rem 1.3rem;font-size:13px;white-space:normal;word-break:break-word;';
      const descP = el('p');
      descP.style.marginBottom = '0.25rem';
      descP.textContent = item.description;
      detail.appendChild(descP);
      if (item.evidence) {
        const evP = el('p', 'muted mono');
        evP.style.cssText = 'font-size:12px;white-space:normal;word-break:break-word;';
        evP.textContent = 'evidence: ' + (typeof item.evidence === 'string' ? item.evidence : JSON.stringify(item.evidence));
        detail.appendChild(evP);
      }
      wrap.appendChild(detail);
    }

    header.addEventListener('click', () => {
      // Load fresh from storage so concurrent tabs don't clobber each other
      const current = loadCritExpanded();
      if (current.has(itemId)) current.delete(itemId);
      else current.add(itemId);
      saveCritExpanded(current);
      // Re-render only the criteria section, passing cached state
      if (_lastCriteria) renderCriteria({ criteria: _lastCriteria });
    });

    list.appendChild(wrap);
  }
  root.appendChild(list);
}

function renderCycles(s) {
  const root = $('cycles');
  root.replaceChildren();
  const c = s.cycles || {};
  const table = el('table', 'center');
  const thead = el('thead');
  const hr = el('tr');
  ['metric', 'value'].forEach((h) => hr.appendChild(el('th', null, h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  const rows = [
    ['cycle dirs', String(c.cycleDirs ?? '?')],
    ['briefings', (c.briefingCount ?? '?') + ' (' + fmtBytes(c.briefingBytes) + ')'],
    ['playbook', fmtBytes(c.playbookBytes) + (c.playbookGrowthBytes ? ' (+' + fmtBytes(c.playbookGrowthBytes) + ')' : '')],
    ['active tasks', fmtBytes(c.activeTasksBytes)],
    ['last compaction', c.lastCompaction ? new Date(c.lastCompaction).toLocaleString() : 'none seen'],
    ['compactions observed', String(c.compactionsObserved ?? 0)],
  ];
  for (const [label, value] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', 'muted', label));
    tr.appendChild(el('td', 'mono', value));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

function renderBurn(s) {
  const b = s.tokens && s.tokens.block;
  if (!b) { $('burn').textContent = 'no active billing block'; return; }
  const parts = [];
  if (b.burnRate && b.burnRate.tokensPerMinute) parts.push('burn ' + fmtTok(Math.round(b.burnRate.tokensPerMinute)) + ' tok/min');
  if (b.projection && b.projection.totalCost !== undefined) parts.push('projected block ' + fmtUsd(b.projection.totalCost));
  else parts.push('block so far ' + fmtUsd(b.costUSD));
  if (b.cacheHitRate !== null) parts.push('cache hit ' + (b.cacheHitRate * 100).toFixed(1) + '%');
  $('burn').textContent = parts.join('  |  ');
}

async function tick() {
  try {
    const res = await fetch('/api/state');
    const s = await res.json();
    renderUnboundBanner(s);
    renderHeader(s);
    renderContextFill(s);
    renderBand(s);
    renderAgents(s);
    renderTree(s);
    renderNodeDetail();
    renderFeed(s);
    renderCriteria(s);
    renderCycles(s);
    renderBurn(s);
    setupTreeInteractions();
    setupRestartToggle();
    $('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('updated').textContent = 'disconnected';
  }
}
tick();
setInterval(tick, 3000);
</script>
</body>
</html>
`;

// ---------- server ----------
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'GET' && url === '/api/state') {
    let body;
    try {
      body = stateJson();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (req.method === 'GET' && url === '/api/registry') {
    const reg = readRegistry();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ sessions: reg.sessions }));
    return;
  }
  // POST /api/restart-toggle: flip enforceRestart for the bound SESSION_ID only.
  // Body is ignored for session selection; only the bound session may be toggled.
  // Returns: { "sessionId": "<id>", "enforceRestart": true|false }
  if (req.method === 'POST' && url === '/api/restart-toggle') {
    // Reject bodies larger than 4 KB to avoid memory accumulation from large payloads.
    const MAX_BODY = 4096;
    let body = '';
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
      if (bodyTooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY) { bodyTooLarge = true; body = ''; }
    });
    req.on('end', () => {
      if (bodyTooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        return;
      }
      // Always use the server-bound SESSION_ID; ignore any sessionId in the body.
      // Accepting a caller-supplied id would let any tab flip another session's toggle.
      const sid = SESSION_ID;
      if (!sid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no session id bound to this dashboard' }));
        return;
      }
      const newValue = flipEnforceRestart(sid);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ sessionId: sid, enforceRestart: newValue }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// Linear-probe on EADDRINUSE: try PORT, PORT+1 .. PORT+20 then exit.
const PORT_PROBE_MAX = 20;
let currentPort = PORT;

function startListening() {
  server.listen(currentPort, HOST, onListening);
}

function onListening() {
  const chosenPort = currentPort;
  if (SESSION_ID && ownEntry) {
    // Record actual chosen port (may differ from the initial PORT after probe)
    ownEntry.port = chosenPort;
    ownEntry.url = 'http://' + HOST + ':' + chosenPort;
    writeRegistryEntry(SESSION_ID, ownEntry);
  }
  // Warm the slow ccusage caches right away.
  refreshCcusage('daily');
  refreshCcusage('session');
  refreshCcusage('blocks');
  const bound = SESSION_ID ? 'session ' + SESSION_ID.slice(0, 8) : 'UNBOUND (showing shared state)';
  const url = 'http://' + HOST + ':' + chosenPort;
  console.log('dashboard listening on ' + url + ' (' + bound + ', company dir: ' + COMPANY_DIR + ')');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const tried = currentPort;
    if (currentPort < PORT + PORT_PROBE_MAX) {
      currentPort++;
      // Remove old listeners so re-listen is clean
      server.close(() => { startListening(); });
    } else {
      process.stderr.write(
        'dashboard: port ' + PORT + ' is in use and probing ' + PORT + '+1..' +
        PORT_PROBE_MAX + ' all failed. Free a port in that range and retry.\n'
      );
      process.exit(1);
    }
    return;
  }
  // Non-EADDRINUSE errors are unexpected - surface them clearly
  process.stderr.write('dashboard: server error: ' + err.message + '\n');
  process.exit(1);
});

startListening();

// Map a raw model id to a human-readable label with context-window note.
// Mirrors the client-side copy inside PAGE for testability.
function humanizeModel(modelId) {
  if (!modelId) return '?';
  const m = String(modelId).toLowerCase();
  let name;
  if (m.includes('fable') || m.includes('mythos')) name = 'Fable 5';
  else if (m.includes('opus-4-8')) name = 'Opus 4.8';
  else if (m.includes('opus-4-5')) name = 'Opus 4.5';
  else if (m.includes('opus-4')) name = 'Opus 4';
  else if (m.includes('sonnet-4')) name = 'Sonnet 4';
  else if (m.includes('sonnet-3-7')) name = 'Sonnet 3.7';
  else if (m.includes('sonnet-3-5')) name = 'Sonnet 3.5';
  else if (m.includes('sonnet')) name = 'Sonnet';
  else if (m.includes('haiku')) name = 'Haiku';
  else name = modelId.replace(/^claude-/, '');
  const win = is1MModel(modelId) ? '1M context' : '200K context';
  return name + ' (' + win + ')';
}

// Test-only exports; the server path never calls require() on itself.
if (typeof module !== 'undefined') {
  module.exports = { usedTokens, humanizeModel };
}
