---
name: company
version: 3.0.0
description: |
  Multi-agent company with feedback loops. Opus thinks, Sonnet executes, Haiku compresses.
  Reads COMPANY.md, runs continuous cycles until priorities are done.
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

# /company — Multi-Agent Company with Feedback Loops

## Architecture

Three tiers. Continuous cycles. Every agent runs.

```
CYCLE N:
  ┌─────────────────────────────────────┐
  │                                     │
  ▼                                     │
THINK (Opus)                            │
  Department leads analyze priorities   │
  Quality critics review previous cycle │
  CEO resolves conflicts                │
  → writes: decisions + tasks           │
  │                                     │
  ▼                                     │
EXECUTE (Sonnet)                        │
  Workers do the actual work            │
  Research, code, scan, measure         │
  → writes: findings + results          │
  │                                     │
  ▼                                     │
COMPRESS (Haiku)                        │
  Summarize all output into a digest    │
  Rate each finding 1-5                 │
  Create next cycle's briefing          │
  → writes: DIGEST.md (feeds back)      │
  │                                     │
  └─────────────────────────────────────┘
  Repeat until: leads say DONE or max cycles reached
```

## Model Tiers

| Tier | Model | Who | Why |
|------|-------|-----|-----|
| THINK | Opus | Leads, critics, strategists, CEO | Decisions need deep reasoning |
| EXECUTE | Sonnet | Workers, engineers, researchers, scouts | Tasks need competence, not genius |
| COMPRESS | Haiku | Digest writer, message router | Summarization is cheap work |

Override any role with `[opus]`, `[sonnet]`, or `[haiku]` in COMPANY.md.

**Cost per cycle:** ~$2-3 (5 Opus thinkers + 15 Sonnet workers + 2 Haiku compressors)
**Cost for 3 cycles:** ~$7-9. All agents run every cycle. With feedback.

## Step 0: Parse COMPANY.md

```bash
for f in COMPANY.md company.md; do [ -f "$f" ] && echo "FOUND: $f" && break; done
```

Read and classify every role into THINK, EXECUTE, or COMPRESS:

- **THINK (Opus):** roles with: lead, director, chief, critic, reviewer, advocate, strategist, CEO, CTO, principal, architect
- **EXECUTE (Sonnet):** roles with: engineer, researcher, scientist, developer, specialist, analyst, scout, designer, writer
- **COMPRESS (Haiku):** auto-created — one per department, summarizes that dept's output

Users override with explicit `[opus]`/`[sonnet]`/`[haiku]` tags.

## Step 1: Initialize

```bash
mkdir -p .company/cycles .company/messages
```

Write `.company/PRIORITIES.md` from COMPANY.md + user instructions.
Write `.company/cycles/cycle-0-briefing.md` as the starting briefing (priorities + rules + any previous state from `.company/STATUS.md`).

## Step 2: Run Cycle (repeat this)

### Phase A — THINK (Opus, parallel)

Launch ALL thinker agents in parallel (typically 5-8). Each gets:

```
You are {ROLE} ({DEPT} department). Cycle {N}.

BRIEFING (from previous cycle's compression):
{contents of .company/cycles/cycle-{N}-briefing.md}

YOUR TEAM (execute-tier agents you can assign tasks to):
{list of Sonnet workers in your department}

INSTRUCTIONS:
1. Read the briefing. What has changed since last cycle?
2. Decide: what tasks should your workers do THIS cycle?
3. Write task assignments to .company/cycles/cycle-{N}-think-{dept}.md
   Format per task:
   TASK: {one clear sentence}
   ASSIGN: {worker role}
   CONTEXT: {relevant info from briefing, max 200 words}
4. If you are a Quality/Critic role: review findings from previous cycle.
   Write verdicts: APPROVED or REJECTED with reason.
5. If all your department's priorities are DONE, write: STATUS: COMPLETE
```

### Phase B — EXECUTE (Sonnet, parallel)

Read all think-phase outputs. Collect tasks per worker. Launch ALL workers in parallel (typically 10-20). Each gets:

```
You are {WORKER_ROLE}. Cycle {N}.

YOUR TASK:
{from the think-phase task assignment}

CONTEXT:
{the 200 words the lead provided}

PREVIOUS WORK:
{contents of .company/{dept}/{worker-slug}.md if exists}

INSTRUCTIONS:
1. Execute the task. Search the web, read code, write code, analyze — whatever it takes.
2. Write your finding to .company/{dept}/{worker-slug}.md
3. Rate your finding: 1 (nothing new) to 5 (breakthrough)
4. Append a message to .company/messages/{dept}.jsonl:
   {"type":"finding|result|blocker|threat","from":"{ROLE}","priority":N,"content":"one paragraph summary"}
```

### Phase C — COMPRESS (Haiku, sequential)

Launch ONE Haiku agent that reads ALL cycle output and creates the next briefing:

```
You are the Company Digest Writer. Cycle {N} just completed.

READ ALL OF THESE:
- .company/cycles/cycle-{N}-think-*.md (all lead decisions)
- .company/messages/*.jsonl (all worker messages from this cycle)
- .company/cycles/cycle-{N}-briefing.md (what they were working from)

WRITE:
.company/cycles/cycle-{N+1}-briefing.md containing:

1. ACCOMPLISHED THIS CYCLE (bullet points, what got done)
2. KEY FINDINGS (priority 4-5 messages, full content)
3. QUALITY VERDICTS (what was approved/rejected)
4. OPEN QUESTIONS (unanswered questions from think phase)
5. BLOCKERS (anything preventing progress)
6. UPDATED PRIORITIES (what should next cycle focus on)
7. CROSS-DEPARTMENT NOTES (findings from one dept that another needs)

Budget: 1500-2500 words. Include ALL priority 4-5 findings in full.
Summarize priority 1-3 findings in one line each.
```

### Phase D — Loop or Stop

Read the new briefing. Check:
- Did any lead write `STATUS: COMPLETE`? → that dept is done
- Are all depts done? → STOP
- Has max_cycles been reached (default: 3)? → STOP
- Otherwise → go to Phase A with cycle N+1

## Step 3: Final Synthesis

After loops end, write `.company/STATUS.md`:

```markdown
# Company Status — {DATE} — {N} cycles completed

## Summary
{what the company accomplished across all cycles}

## All Findings (by priority)
### Priority 5 (Breakthroughs)
{full content}
### Priority 4 (Important)
{full content}
### Priority 3 (Useful)
{one line each}

## Quality Verdicts
{approved and rejected claims}

## Remaining Work
{what didn't get done, for next session}
```

## Feedback Loop Benefits

Cycle 1 output feeds Cycle 2 input. This means:
- Research findings inform engineering decisions in the SAME session
- Quality rejections trigger rework in the NEXT cycle
- Scout alerts cause strategy pivots immediately
- Workers build on each other's findings, not working blind

Without the loop: agents work in isolation, findings never cross-pollinate.
With the loop: 3 cycles of the full company = 3x agent-actions, each informed by all previous actions.

## File Structure

```
.company/
├── PRIORITIES.md
├── STATUS.md
├── messages/
│   ├── research.jsonl
│   ├── engineering.jsonl
│   └── quality.jsonl
├── cycles/
│   ├── cycle-0-briefing.md      ← initial priorities
│   ├── cycle-1-think-research.md
│   ├── cycle-1-think-engineering.md
│   ├── cycle-1-briefing.md      ← Haiku digest after cycle 1
│   ├── cycle-2-think-research.md
│   ├── cycle-2-briefing.md      ← Haiku digest after cycle 2
│   └── ...
├── research/
│   ├── REPORT.md
│   ├── info-theorist.md
│   └── lattice-math.md
└── engineering/
    ├── REPORT.md
    └── benchmark-eng.md
```

## Incremental Sessions

Next session, `/company` reads `.company/STATUS.md` and `.company/cycles/` to see where things left off. The latest briefing becomes cycle 0 for the new session. No work is lost.
