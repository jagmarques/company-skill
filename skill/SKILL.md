---
name: company
version: 2.0.0
description: |
  Multi-agent company orchestrator. Reads COMPANY.md, runs agents in waves,
  typed message passing, adaptive output budgets, context monitoring.
  Use when: "launch company", "start company", "all agents", "full team".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - WebSearch
  - WebFetch
---

# /company — Multi-Agent Company Orchestrator v2

You are the CEO. Read a company structure, run it as waves of parallel agents.

## Step 0: Parse COMPANY.md

```bash
for f in COMPANY.md company.md; do [ -f "$f" ] && echo "FOUND: $f" && break; done
```

Read and parse into departments, roles, priorities, and rules.

**Model assignment:** Explicit `[opus]`/`[sonnet]`/`[haiku]` tags win. Default: `opus`.

**Auto-grouping** (if no departments defined): group by function — research, engineering, quality, writing, intelligence.

## Step 1: Initialize

```bash
mkdir -p .company/messages
```

Create `.company/PRIORITIES.md` from COMPANY.md priorities + user instructions + `.planning/NEXT_SESSION.md`.

## Step 2: Run in Waves (from oh-my-claudecode)

NOT all agents at once. Run in waves of 5-6, each wave's output feeds the next.

```
Wave 1: Department Leads (all parallel, 5-6 agents)
    ↓ each lead writes REPORT.md
Wave 2: Workers for URGENT priorities (parallel per dept, 3-4 per lead)
    ↓ each worker writes {worker}.md
Wave 3: Quality review of Wave 1+2 findings (2-3 agents)
    ↓ quality writes verdicts
Wave 4: CEO synthesis (you)
```

Each wave starts FRESH — agents in Wave 2 don't inherit Wave 1's context.
They read only: their task + previous findings files. Context stays small.

## Step 3: Typed Messages (from Overstory)

Agents communicate via typed JSON messages in `.company/messages/`:

```json
{"type": "finding", "from": "Lattice Mathematician", "to": "all", "priority": 3, "content": "Shell-based E8 encoding saves 23% at 3-bit", "timestamp": "2026-03-30T01:00:00Z"}
{"type": "question", "from": "CTO", "to": "Numerical Stability Engineer", "priority": 4, "content": "Does ScreeNOT handle correlated noise?", "timestamp": "..."}
{"type": "blocker", "from": "Chief Critic", "to": "all", "priority": 5, "content": "MP threshold claim fails on correlated data. DO NOT use in paper.", "timestamp": "..."}
{"type": "result", "from": "Benchmark Engineer", "to": "all", "priority": 4, "content": "E8 3-bit + temporal delta = 5.68x on real KV. Validated.", "timestamp": "..."}
{"type": "threat", "from": "GitHub Scout", "to": "CEO", "priority": 5, "content": "LatticeQuant repo appeared today doing E8 + entropy for KV cache", "timestamp": "..."}
```

**Message types:** finding, question, answer, result, blocker, threat, task, done, veto

**Priority:** 1 (low) to 5 (critical). Agents reading messages filter by priority >= 3 to save tokens.

Messages append to `.company/messages/{dept}.jsonl` (one file per department, append-only).

## Step 4: Adaptive Output Budget (rate-distortion inspired)

Workers self-rate their finding's importance (1-5) and get proportional output:

| Rating | Meaning | Budget |
|--------|---------|--------|
| 1 | Nothing new | 50 words |
| 2 | Minor update | 150 words |
| 3 | Useful finding | 400 words |
| 4 | Important result with evidence | 800 words |
| 5 | Breakthrough — changes strategy | 1500 words + data |

Inject this into every worker's prompt:
```
Rate your finding 1-5. Write proportionally. A "nothing new" is 50 words.
A breakthrough gets 1500 words. Don't waste tokens on low-value output.
```

## Step 5: Launch Wave 1 — Department Leads

For EACH department, launch an Agent (ALL in a single message for parallel execution):

```
You are {LEAD_ROLE}, leading {DEPT_NAME}.

TEAM: {worker list with descriptions}
PRIORITIES: {from .company/PRIORITIES.md}
PREVIOUS STATE: {from .company/{dept}/REPORT.md if exists}
MESSAGES: {from .company/messages/{dept}.jsonl, priority >= 3}
RULES: {from COMPANY.md rules section}

INSTRUCTIONS:
1. Read priorities. Decide which workers to activate for URGENT items.
2. For each worker, spawn a sub-agent with model: opus.
   Give ONE specific task. Worker writes to .company/{dept}/{worker-slug}.md
   Worker also appends a typed JSON message to .company/messages/{dept}.jsonl
3. If .company/{dept}/{worker-slug}.md already has a recent answer, SKIP that worker.
4. After workers finish:
   - Write .company/{dept}/REPORT.md (synthesis, max 800 words)
   - Append typed messages to .company/messages/{dept}.jsonl for cross-dept findings

WORKER PROMPT TEMPLATE:
You are {WORKER_ROLE}. One task: {SPECIFIC_TASK}
Previous findings: {contents of .company/{dept}/{worker-slug}.md or "none"}
Rate your finding 1-5 and write proportionally (50-1500 words).
Append a JSON message to .company/messages/{dept}.jsonl:
{"type":"finding|result|blocker|threat","from":"{WORKER_ROLE}","to":"all","priority":N,"content":"..."}
```

## Step 6: Launch Wave 2 — Quality Gate

After Wave 1 completes, launch the Quality department (if defined):

The quality lead reads ALL `.company/messages/*.jsonl` files and reviews:
- Every `finding` and `result` message gets a verdict
- `blocker` messages get escalated
- Writes verdicts as `veto` or `approved` messages

## Step 7: CEO Synthesis

Read:
- All `.company/messages/*.jsonl` (filtered priority >= 3)
- All `.company/{dept}/REPORT.md`

Write `.company/STATUS.md`:
```markdown
# Company Status — {DATE}

## Wave Summary
- Wave 1: {N} leads, {M} workers activated
- Wave 2: {K} quality reviews

## Key Findings (priority 4-5 only)
{from typed messages}

## Quality Verdicts
{approved / vetoed claims}

## Threats
{from scout messages}

## Next Priorities
{updated based on findings}
```

## Incremental Runs (from agent_farm)

On repeat runs:
1. Read `.company/STATUS.md` — what happened last time
2. Read `.company/messages/*.jsonl` — accumulated knowledge
3. Skip departments with no new priorities
4. Skip workers whose `.company/{dept}/{worker}.md` already answers current priorities
5. Only launch waves that have work to do

## Agent Dropout (from ACL 2025)

Track which workers produced priority 4-5 findings vs priority 1-2.

On next run:
- Priority 4-5 producers: auto-activate for related priorities
- Priority 1-2 producers: skip unless priorities changed
- Never-activated workers: try once, then skip if low-value

## Context Hygiene (from agent_farm)

Each agent gets ONLY:
- Its task (1-3 sentences)
- Its previous findings file (if exists)
- Relevant typed messages (priority >= 3)
- Rules from COMPANY.md

NEVER give an agent:
- The full conversation history
- Other departments' full reports
- All messages (only priority >= 3)
- The CEO's synthesis (that's for humans)

This keeps each agent's input under 3000 tokens even in a 40-role company.
