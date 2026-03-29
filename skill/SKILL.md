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

## Step 1: Install and Detect Skills

The company skill auto-installs recommended skill packs that make agents more powerful.

```bash
# Check what's already installed
INSTALLED=$(for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do
  [ -f "$d" ] && basename "$(dirname "$d")"
done 2>/dev/null | sort -u)
echo "Already installed: $INSTALLED"

# Install gstack (gives: review, ship, qa, investigate, browse, benchmark, etc.)
if ! echo "$INSTALLED" | grep -q "gstack"; then
  echo "Installing gstack skill pack..."
  cd ~/.claude/skills 2>/dev/null || mkdir -p ~/.claude/skills && cd ~/.claude/skills
  git clone --depth 1 https://github.com/gstack-com/gstack.git 2>/dev/null && echo "gstack installed" || echo "gstack install failed (optional)"
fi

# Install GSD (gives: plan-phase, execute-phase, verify-work, progress, etc.)
if ! echo "$INSTALLED" | grep -q "gsd"; then
  echo "Installing GSD..."
  npx -y gsd-install 2>/dev/null && echo "GSD installed" || echo "GSD install failed (optional)"
fi

# Re-detect after install
for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do
  [ -f "$d" ] && basename "$(dirname "$d")"
done 2>/dev/null | sort -u
```

Build {DETECTED_SKILLS} from the output. Map each to a one-line description:

| Skill | Description for leads |
|-------|----------------------|
| review | /review — code review with structural analysis |
| investigate | /investigate — systematic debugging, root cause |
| ship | /ship — PR creation, changelog, push |
| qa | /qa — headless browser testing |
| browse | /browse — navigate URLs, screenshot, verify |
| benchmark | /benchmark — performance regression detection |
| plan-eng-review | /plan-eng-review — architecture review |
| plan-ceo-review | /plan-ceo-review — strategic scope review |
| retro | /retro — engineering retrospective |
| office-hours | /office-hours — strategy forcing questions |
| codex | /codex — independent code review |
| design-review | /design-review — visual QA |
| gsd:plan-phase | /gsd:plan-phase — detailed execution planning |
| gsd:verify-work | /gsd:verify-work — feature validation |
| gsd:progress | /gsd:progress — project state check |

**If installs fail, the skill still works.** Agents fall back to raw tools. Skills are power-ups — the company runs with or without them.

## Step 2: Initialize

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

AVAILABLE SKILLS (auto-detected — only shows what's installed):
{DETECTED_SKILLS}

If no skills are detected, workers do everything with raw tools (Read, Write,
Edit, Bash, Grep, Glob, Agent, WebSearch). Skills are optional power-ups.

When a task matches a skill, TELL YOUR WORKER TO USE THAT SKILL instead of
doing it manually. A lead assigning "review the auth code" should write:
  TASK: Run /review on the auth module changes
  ASSIGN: Code Reviewer
Not: "Read every file and check for bugs manually."

INSTRUCTIONS:
1. Read the briefing. What has changed since last cycle?
2. Decide: what tasks should your workers do THIS cycle?
3. For each task, check if an AVAILABLE SKILL handles it. If yes, assign the skill.
4. Write task assignments to .company/cycles/cycle-{N}-think-{dept}.md
   Format per task:
   TASK: {one clear sentence}
   ASSIGN: {worker role}
   SKILL: {skill to use, or "none" if raw work}
   CONTEXT: {relevant info from briefing, max 200 words}
5. If you are a Quality/Critic role: review findings from previous cycle.
   Write verdicts: APPROVED or REJECTED with reason.
6. If all your department's priorities are DONE, write: STATUS: COMPLETE
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

SKILL TO USE: {from lead's assignment, or "none — use raw tools"}

INSTRUCTIONS:
1. If a SKILL was assigned and it exists, USE IT. Skills are expert workflows.
2. If the skill doesn't exist or none was assigned, use raw tools:
   Read, Write, Edit, Bash, Grep, Glob, WebSearch — whatever the task needs.
3. Write your finding to .company/{dept}/{worker-slug}.md
4. Rate your finding: 1 (nothing new) to 5 (breakthrough)
5. Append a message to .company/messages/{dept}.jsonl:
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
