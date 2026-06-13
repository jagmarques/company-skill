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
 * Run: node scripts/dashboard.js [--port N] [--company-dir PATH]
 * Binds 127.0.0.1 only, hardcoded. Default port 7777.
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
const PORT = Number(argValue('--port') || process.env.PORT || 7777);
const HOST = '127.0.0.1'; // hardcoded loopback, never 0.0.0.0

function resolveCompanyDir() {
  const flag = argValue('--company-dir');
  if (flag) return path.resolve(flag);
  if (process.env.COMPANY_DIR) return path.resolve(process.env.COMPANY_DIR);
  const local = path.resolve('.company');
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), '.company');
}
const COMPANY_DIR = resolveCompanyDir();

// ---------- tiny caches ----------
const FILE_TTL = 2000; // 2s for file reads
const CC_TTL = 60000; // 60s for ccusage exec results
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
// pin = current top tier since Fable 5 is pulled; revert to fable when it returns
const TOP_TIER_BASELINE = 'claude-opus-4-8';

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
  return { i: 10, o: 50, w: 12.5, r: 1, est: true }; // unknown: price at best known rates, mark est.
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

function computeSavings(win) {
  if (!win || !win.models.length) {
    return {
      tieringSaved: null, cacheSaved: null, bestModel: null, estimated: false,
      caveat: 'Approximate: computed from API list prices. On a subscription plan these dollars are notional.'
    };
  }
  let estimated = false;
  // Use a fixed top-tier baseline so the saving means "vs all TOP_TIER_BASELINE".
  const topPrice = priceFor(TOP_TIER_BASELINE);
  // Hypothetical cost if every token billed at the top-tier rate.
  const hypothetical =
    (win.input * topPrice.i + win.output * topPrice.o +
      win.cacheCreation * topPrice.w + win.cacheRead * topPrice.r) / 1e6;
  // Recompute actual cost from priceFor() so both sides use the same price table.
  // Using win.cost (from ccusage) here would introduce phantom savings when
  // ccusage's internal table differs from priceFor() (e.g. during FORCE_BEST).
  let actualCost = 0;
  let cacheSaved = 0;
  for (const m of win.models) {
    const p = priceFor(m.model);
    if (p.est) estimated = true;
    actualCost +=
      (m.input * p.i + m.output * p.o + m.cacheCreation * p.w + m.cacheRead * p.r) / 1e6;
    // Cache savings = tokens read at cache price vs what they would cost at full input price.
    cacheSaved += (m.cacheRead * (p.i - p.r)) / 1e6;
  }
  const tieringSaved = Math.max(0, hypothetical - actualCost);
  return {
    tieringSaved, cacheSaved, topTierModel: TOP_TIER_BASELINE, estimated,
    caveat: 'Approximate: computed from API list prices. On a subscription plan these dollars are notional.'
  };
}

// ---------- transcripts ----------
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
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
  let model = null, tokens = 0, toolCalls = 0;
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message) continue;
    if (e.message.model) model = e.message.model;
    const u = e.message.usage;
    if (u) {
      tokens += (u.input_tokens || 0) + (u.output_tokens || 0) +
        (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    const content = Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of content) if (c.type === 'tool_use') toolCalls++;
  }
  const val = { model, tokens, toolCalls };
  agentParseCache.set(file, { mtimeMs: st.mtimeMs, val });
  return val;
}

const ACTIVE_MS = 20000;
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
    const active = st ? ageMs < ACTIVE_MS : false;
    const agent = {
      id: id.replace(/^agent-/, '').slice(0, 8),
      agentType: meta.agentType || 'agent',
      description: String(meta.description || '').slice(0, 120),
      active,
      status: !st ? 'unknown' : active ? (ageMs < 10000 ? 'running' : 'finishing') : 'finished',
      mtimeMs
    };
    if (active && st) {
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

function rosterRoles() {
  const text = cachedReadFile(path.join(COMPANY_DIR, 'active-roster.md'));
  if (!text) return [];
  const roles = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+)/) || line.match(/^#{2,3}\s+(.+)/);
    if (m) roles.push(m[1].replace(/[*_`]/g, '').slice(0, 80));
    if (roles.length >= 24) break;
  }
  return roles;
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
    description: String(c.description || '').slice(0, 140),
    passes: !!c.passes,
    evidence: !!(c.evidence && String(c.evidence).trim())
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

// ---------- /api/state ----------
function buildState() {
  // tokens
  const daily = getCcusage('daily');
  const session = getCcusage('session');
  const blocks = getCcusage('blocks');

  const todayIso = new Date().toISOString().slice(0, 10);
  let today = null;
  if (daily && Array.isArray(daily.daily)) {
    const row = daily.daily.find((d) => String(d.date || '').startsWith(todayIso)) || daily.daily[daily.daily.length - 1];
    if (row) today = summarizeBreakdowns(row.modelBreakdowns);
  }

  // transcripts
  const projDir = projectDir();
  let orch = { sessionModel: null, events: [] };
  let agents = [];
  let sessionInfo = null;
  if (projDir) {
    const sess = newestSessionFile(projDir);
    if (sess) {
      orch = parseOrchestrator(sess.file);
      agents = collectAgents(projDir, sess.id);
      sessionInfo = { id: sess.id.slice(0, 8) };
      if (session && Array.isArray(session.session)) {
        const row =
          session.session.find((s) => String(s.period || '').includes(sess.id) || String(s.agent || '').includes(sess.id)) ||
          null;
        if (row) sessionInfo.usage = summarizeBreakdowns(row.modelBreakdowns);
      }
    }
  }

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
  return {
    tokens: { available: !!(daily || session || blocks), today, session: sessionInfo, block },
    savings: computeSavings(today),
    agents: activeAgents.map((a) => ({
      agentType: a.agentType, model: a.model || null, description: a.description,
      status: a.status, runtimeMs: a.runtimeMs || null, tokens: a.tokens || 0, toolCalls: a.toolCalls || 0
    })),
    hierarchy: {
      orchestrator: { model: orch.sessionModel, id: sessionInfo ? sessionInfo.id : null },
      children: agents.slice(0, 60).map((a) => ({ id: a.id, agentType: a.agentType, description: a.description, active: a.active })),
      roster: rosterRoles()
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
.mono, td.num, .stat b { font-family: var(--font-mono); }
.muted { color: var(--dim); }
.topline { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1.5rem; }
.stats { display: flex; flex-wrap: wrap; gap: 2.5rem; margin-bottom: 1rem; }
.stat { min-width: 9rem; }
.stat .label { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
.stat b { font-size: 22px; font-weight: 600; display: block; margin-top: 0.15rem; }
.stat .sub { font-size: 12px; color: var(--dim); }
.splitbar { display: flex; height: 8px; border-radius: var(--radius-pill); overflow: hidden; background: var(--hover); margin: 0.5rem 0 0.35rem; }
.splitbar span { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 1rem; font-size: 12px; color: var(--dim); }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.35rem; }
.caveat { font-size: 12px; color: var(--dim); margin-top: 0.5rem; }
.band { background: var(--band); border: 1px solid var(--band-border); color: #d6d9dd; border-radius: var(--radius-menu); padding: 0.6rem 1rem; display: flex; flex-wrap: wrap; gap: 1.75rem; font-size: 13px; margin: 1.5rem 0; }
.band b { color: #fff; font-weight: 600; }
.band .halt { color: var(--red); font-weight: 700; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 1.5rem; margin-bottom: 1.5rem; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); font-weight: 600; padding: 0 0.75rem 0.5rem 0; border-bottom: 1px solid var(--line); }
td { padding: 0.5rem 0.75rem 0.5rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.num { text-align: right; white-space: nowrap; }
th.num { text-align: right; }
.pill { display: inline-block; border-radius: var(--radius-pill); padding: 0.1rem 0.6rem; font-size: 12px; font-weight: 600; }
.pill.run { background: rgba(31,136,61,0.1); color: var(--accent); }
.pill.fin { background: var(--hover); color: var(--dim); }
.empty { color: var(--dim); font-size: 13.5px; padding: 0.5rem 0; }
.hier { display: flex; gap: 1.5rem; align-items: flex-start; }
.hier svg { flex: 1; min-width: 0; }
.roster { width: 15rem; flex-shrink: 0; font-size: 12.5px; color: var(--dim); border-left: 1px solid var(--line); padding-left: 1.25rem; }
.roster li { list-style: none; padding: 0.15rem 0; }
.feed { font-size: 13px; max-height: 22rem; overflow-y: auto; }
.feed .row { display: flex; gap: 0.75rem; padding: 0.3rem 0; border-bottom: 1px solid var(--line); }
.feed .row:last-child { border-bottom: none; }
.feed .ts { font-family: var(--font-mono); color: var(--dim); white-space: nowrap; font-size: 12px; padding-top: 0.1rem; }
.feed .kind { font-weight: 600; width: 3.5rem; flex-shrink: 0; }
.feed .kind.spawn { color: var(--cyan); }
.feed .kind.finish { color: var(--accent); }
.progress { height: 8px; background: var(--hover); border-radius: var(--radius-pill); overflow: hidden; margin: 0.5rem 0 1rem; }
.progress span { display: block; height: 100%; background: var(--accent); }
.crit { display: flex; gap: 0.6rem; padding: 0.25rem 0; font-size: 13.5px; align-items: baseline; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line); flex-shrink: 0; position: relative; top: 1px; }
.dot.pass { background: var(--accent); }
.kv { display: flex; flex-wrap: wrap; gap: 2rem; font-size: 13.5px; }
.kv div span { display: block; font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
.kv div b { font-family: var(--font-mono); font-weight: 600; }
footer { margin-top: 2rem; font-size: 12.5px; color: var(--dim); border-top: 1px solid var(--line); padding-top: 1rem; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }
@media (max-width: 760px) { .roster { display: none; } .stats { gap: 1.5rem; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="topline">
    <h1>Company dashboard</h1>
    <span class="muted mono" id="updated">connecting</span>
  </div>

  <section id="header-strip">
    <div class="stats" id="stats"></div>
    <div class="splitbar" id="splitbar"></div>
    <div class="legend" id="legend"></div>
    <div class="caveat" id="caveat"></div>
  </section>

  <div class="band" id="policy-band"></div>

  <div class="card">
    <h2>Active agents</h2>
    <div id="agents"></div>
  </div>

  <div class="card">
    <h2>Company hierarchy</h2>
    <div class="hier">
      <svg id="tree" preserveAspectRatio="xMidYMin meet"></svg>
      <div class="roster"><h2>Declared roster</h2><ul id="roster"></ul></div>
    </div>
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
    <div class="kv" id="cycles"></div>
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
  add('session model', shortModel(p.sessionModel));
  add('owners', String(p.ownerCount ?? '?'));
  if (p.halt) band.appendChild(el('span', 'halt', 'HALT REQUESTED'));
}

function renderAgents(s) {
  const root = $('agents');
  root.replaceChildren();
  const agents = s.agents || [];
  if (!agents.length) { root.appendChild(el('div', 'empty', 'No agents running')); return; }
  const table = el('table');
  const thead = el('thead'); const hr = el('tr');
  ['agent', 'model', 'task', 'status', 'runtime', 'tokens', 'tool calls'].forEach((h, i) => {
    const th = el('th', i >= 4 ? 'num' : null, h); hr.appendChild(th);
  });
  thead.appendChild(hr); table.appendChild(thead);
  const tbody = el('tbody');
  for (const a of agents) {
    const tr = el('tr');
    tr.appendChild(el('td', null, a.agentType));
    tr.appendChild(el('td', 'num', shortModel(a.model)));
    tr.appendChild(el('td', null, a.description));
    const td = el('td'); td.appendChild(el('span', 'pill run', a.status)); tr.appendChild(td);
    tr.appendChild(el('td', 'num', fmtDur(a.runtimeMs)));
    tr.appendChild(el('td', 'num', fmtTok(a.tokens)));
    tr.appendChild(el('td', 'num', String(a.toolCalls)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

function renderTree(s) {
  const svg = $('tree');
  svg.replaceChildren();
  const h = s.hierarchy || {};
  const kids = h.children || [];
  const lanes = new Map();
  for (const k of kids) {
    if (!lanes.has(k.agentType)) lanes.set(k.agentType, []);
    lanes.get(k.agentType).push(k);
  }
  const laneNames = [...lanes.keys()];
  const W = 900;
  const laneW = laneNames.length ? W / laneNames.length : W;
  const rowH = 26, topY = 70;
  const maxRows = Math.max(1, ...laneNames.map((l) => lanes.get(l).length));
  const H = topY + 30 + maxRows * rowH + 10;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('height', Math.min(H, 460));
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  // orchestrator node
  const ox = W / 2;
  svg.appendChild(mk('rect', { x: ox - 110, y: 8, width: 220, height: 34, rx: 10, fill: '#0a0a0a' }));
  svg.appendChild(mk('text', { x: ox, y: 30, 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 12, 'font-family': 'ui-monospace, Menlo, monospace' },
    'orchestrator ' + shortModel(h.orchestrator && h.orchestrator.model) + (h.orchestrator && h.orchestrator.id ? ' ' + h.orchestrator.id : '')));
  laneNames.forEach((lane, li) => {
    const cx = laneW * li + laneW / 2;
    svg.appendChild(mk('line', { x1: ox, y1: 42, x2: cx, y2: topY - 6, stroke: '#d1d9e0', 'stroke-width': 1 }));
    svg.appendChild(mk('text', { x: cx, y: topY + 8, 'text-anchor': 'middle', fill: '#59636e', 'font-size': 11, 'font-weight': 600 }, lane));
    lanes.get(lane).forEach((k, ki) => {
      const y = topY + 22 + ki * rowH;
      const color = k.active ? '#1f883d' : '#59636e';
      svg.appendChild(mk('circle', { cx: cx - laneW / 2 + 14, cy: y - 4, r: 4, fill: k.active ? '#1f883d' : '#d1d9e0' }));
      const label = (k.description || k.id || '').slice(0, Math.max(8, Math.floor(laneW / 7)));
      svg.appendChild(mk('text', { x: cx - laneW / 2 + 24, y, fill: color, 'font-size': 11 }, label));
    });
  });
  const roster = $('roster');
  roster.replaceChildren();
  (h.roster || []).forEach((r) => roster.appendChild(el('li', null, r)));
  if (!(h.roster || []).length) roster.appendChild(el('li', null, 'no roster file'));
}

function renderFeed(s) {
  const root = $('feed');
  root.replaceChildren();
  const feed = s.feed || [];
  if (!feed.length) { root.appendChild(el('div', 'empty', 'No spawn or finish events in the current transcript tail')); return; }
  for (const e of feed) {
    const row = el('div', 'row');
    row.appendChild(el('span', 'ts', e.ts ? new Date(e.ts).toLocaleTimeString() : '?'));
    row.appendChild(el('span', 'kind ' + e.kind, e.kind));
    row.appendChild(el('span', null, e.agentType + ': ' + e.description));
    root.appendChild(row);
  }
}

function renderCriteria(s) {
  const root = $('criteria');
  root.replaceChildren();
  const c = s.criteria || {};
  if (!c.total) { root.appendChild(el('div', 'empty', 'No criteria.json found')); return; }
  root.appendChild(el('div', 'muted', (c.passed || 0) + ' of ' + c.total + ' criteria passing'));
  const bar = el('div', 'progress');
  const fill = el('span');
  fill.style.width = ((c.passed / c.total) * 100).toFixed(2) + '%';
  bar.appendChild(fill);
  root.appendChild(bar);
  for (const item of c.items || []) {
    const row = el('div', 'crit');
    row.appendChild(el('span', 'dot' + (item.passes ? ' pass' : '')));
    row.appendChild(el('span', null, item.id + '. ' + item.description));
    row.appendChild(el('span', 'muted mono', item.evidence ? 'evidence' : ''));
    root.appendChild(row);
  }
}

function renderCycles(s) {
  const root = $('cycles');
  root.replaceChildren();
  const c = s.cycles || {};
  const add = (label, value) => {
    const d = el('div');
    d.appendChild(el('span', null, label));
    d.appendChild(el('b', null, value));
    root.appendChild(d);
  };
  add('cycle dirs', String(c.cycleDirs ?? '?'));
  add('briefings', (c.briefingCount ?? '?') + ' (' + fmtBytes(c.briefingBytes) + ')');
  add('playbook', fmtBytes(c.playbookBytes) + (c.playbookGrowthBytes ? ' (+' + fmtBytes(c.playbookGrowthBytes) + ')' : ''));
  add('active tasks', fmtBytes(c.activeTasksBytes));
  add('last compaction', c.lastCompaction ? new Date(c.lastCompaction).toLocaleString() : 'none seen');
  add('compactions observed', String(c.compactionsObserved ?? 0));
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
    renderHeader(s); renderBand(s); renderAgents(s); renderTree(s);
    renderFeed(s); renderCriteria(s); renderCycles(s); renderBurn(s);
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
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  // Warm the slow ccusage caches right away.
  refreshCcusage('daily');
  refreshCcusage('session');
  refreshCcusage('blocks');
  console.log('dashboard listening on http://' + HOST + ':' + PORT + ' (company dir: ' + COMPANY_DIR + ')');
});
