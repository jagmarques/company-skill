---
name: company
version: 3.2.0
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
  - Skill
---

# /company — Multi-Agent Company with Feedback Loops

## Architecture

```
CYCLE N:
  ┌─────────────────────────────────────┐
  │                                     │
  ▼                                     │
THINK (Opus)                            │
  Leads analyze priorities + assign     │
  Critics review previous cycle         │
  → writes: decisions + task list       │
  │                                     │
  ▼                                     │
EXECUTE (Sonnet)                        │
  Workers do the actual work            │
  Use skills (/review, /qa, etc.)       │
  → writes: findings + results          │
  │                                     │
  ▼                                     │
COMPRESS (Haiku)                        │
  Summarize into next cycle's briefing  │
  → writes: cycle-{N+1}-briefing.md     │
  │                                     │
  └─────────────────────────────────────┘
  Repeat until: leads say DONE or max 3 cycles
```

## Model Tiers

| Tier | Model | Who | Why |
|------|-------|-----|-----|
| THINK | Opus | Leads, critics, strategists | Decisions need deep reasoning |
| EXECUTE | Sonnet | Workers, engineers, researchers, scouts | Tasks need competence |
| COMPRESS | Haiku | Digest writer | Summarization is cheap |

Override any role with `[opus]`, `[sonnet]`, or `[haiku]` in COMPANY.md.

## Step 1: Parse COMPANY.md

```bash
for f in COMPANY.md company.md; do [ -f "$f" ] && echo "FOUND: $f" && break; done
```

Read the file. If not found, tell the user to create one.

Classify every role:
- **THINK (Opus):** lead, director, chief, critic, reviewer, advocate, strategist, CEO, CTO, principal, architect
- **EXECUTE (Sonnet):** engineer, researcher, scientist, developer, specialist, analyst, scout, designer, writer
- **COMPRESS (Haiku):** auto-created — one per department

Explicit `[opus]`/`[sonnet]`/`[haiku]` tags in COMPANY.md override these defaults.

If no `## Departments` or `##` headers found, auto-group by function:
- Research/science/theory/math → Research dept
- Engineering/code/build/test → Engineering dept
- Quality/review/critic/audit → Quality dept
- Writing/paper/docs/design → Paper dept
- Scout/scan/monitor/track → Intelligence dept

If no `## Priorities` found, ask the user what to work on.

## Step 2: Install and Detect Skills

```bash
INSTALLED=$(for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do
  [ -f "$d" ] && basename "$(dirname "$d")"
done 2>/dev/null | sort -u)
echo "Installed: $INSTALLED"

# Auto-install missing packs (all optional, failures don't block)
echo "$INSTALLED" | grep -q "gstack" || npx gstack@latest install 2>/dev/null || true
echo "$INSTALLED" | grep -q "gsd" || npx -y gsd-install 2>/dev/null || true
echo "$INSTALLED" | grep -q "superpowers" || (mkdir -p ~/.claude/skills/superpowers && curl -sL "https://raw.githubusercontent.com/obra/superpowers-marketplace/main/skills/superpowers/SKILL.md" -o ~/.claude/skills/superpowers/SKILL.md 2>/dev/null) || true
echo "$INSTALLED" | grep -q "trailofbits" || (git clone --depth 1 https://github.com/trailofbits/skills.git /tmp/tob-skills 2>/dev/null && cp -r /tmp/tob-skills/.claude/skills/* ~/.claude/skills/ 2>/dev/null && rm -rf /tmp/tob-skills) || true

# Final detection
echo "=== Available ==="
for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do
  [ -f "$d" ] && basename "$(dirname "$d")"
done 2>/dev/null | sort -u
```

Build {DETECTED_SKILLS} — a bullet list of installed skills with one-line descriptions.
If nothing is installed, agents use raw tools (Read, Write, Edit, Bash, Grep, Glob, WebSearch).

## Step 3: Initialize Workspace

```bash
mkdir -p .company/cycles .company/messages .company/memory
echo ".company/" >> .gitignore 2>/dev/null || true
```

Write `.company/PRIORITIES.md` from: COMPANY.md priorities + user instructions + any `.planning/NEXT_SESSION.md`.

Write `.company/cycles/cycle-0-briefing.md` as the starting briefing:
- Priorities
- Rules from COMPANY.md
- Previous state from `.company/STATUS.md` (if exists from last session)
- Previous memory from `.company/memory/*.json` (if exists)

## Step 4: Run Cycle

### Phase A — THINK (Opus, parallel)

Launch ALL lead/critic/strategist agents in ONE message (parallel). Each gets:

```
You are {ROLE} ({DEPT} department). Cycle {N}.

BRIEFING:
{contents of .company/cycles/cycle-{N}-briefing.md}

YOUR TEAM:
{list of Sonnet workers in your department with descriptions}

AVAILABLE SKILLS:
{DETECTED_SKILLS list, or "None — use raw tools (Read, Write, Bash, WebSearch, etc.)"}

INSTRUCTIONS:
1. Read the briefing. What changed since last cycle?
2. Decide which workers to activate for URGENT priorities.
3. Write task list to .company/cycles/cycle-{N}-think-{dept}.md:

   TASK: {one sentence}
   ASSIGN: {worker role}
   SKILL: {/review, /investigate, /qa, etc. or "raw" if no skill fits}
   CONTEXT: {max 200 words of relevant info}

   TASK: {next task}
   ...

4. Quality/Critic roles: review previous cycle findings.
   Write APPROVED or REJECTED with reason for each claim.
5. If your department's work is done: write STATUS: COMPLETE
```

### Phase B — EXECUTE (Sonnet, parallel)

Read all Phase A outputs. Collect task assignments. Launch ALL assigned workers in parallel. Each gets:

```
You are {WORKER_ROLE}. Cycle {N}.

TASK: {from lead's assignment}
CONTEXT: {from lead's assignment}
SKILL: {assigned skill or "raw"}
PREVIOUS WORK: {contents of .company/{dept}/{worker-slug}.md if exists, else "none"}

INSTRUCTIONS:
1. If a skill was assigned: use the Skill tool to invoke it.
   Example: Use Skill tool with skill="/review" or skill="/investigate".
   If the skill isn't available, fall back to raw tools.
2. If "raw": use Read, Write, Edit, Bash, Grep, Glob, WebSearch directly.
3. Write findings to .company/{dept}/{worker-slug}.md
4. Rate your finding 1-5 (1=nothing new, 5=breakthrough).
5. Append to .company/messages/{dept}.jsonl:
   {"type":"finding","from":"{ROLE}","priority":N,"content":"summary"}
```

### Phase C — COMPRESS (Haiku)

Launch ONE Haiku agent:

```
You are the Digest Writer. Cycle {N} complete.

Read these files:
1. All .company/cycles/cycle-{N}-think-*.md files (use Glob to find them)
2. All .company/messages/*.jsonl files
3. .company/cycles/cycle-{N}-briefing.md

Write .company/cycles/cycle-{N+1}-briefing.md:

1. ACCOMPLISHED (bullet points)
2. KEY FINDINGS (priority 4-5: full content. Priority 1-3: one line each)
3. QUALITY VERDICTS (approved/rejected)
4. OPEN QUESTIONS
5. BLOCKERS
6. UPDATED PRIORITIES (what next cycle should focus on)
7. CROSS-DEPARTMENT NOTES

Budget: 1500-2500 words. Don't drop priority 4-5 findings.
```

### Phase D — Loop or Stop

Check:
- All departments wrote STATUS: COMPLETE → STOP
- Reached max 3 cycles → STOP
- Otherwise → back to Phase A with cycle N+1

## Step 5: Final Synthesis

Write `.company/STATUS.md`:

```markdown
# Company Status — {DATE} — {N} cycles

## Summary
{what got done}

## Findings (by priority)
### Priority 5
{full content}
### Priority 4
{full content}
### Priority 3
{one line each}

## Quality Verdicts
{approved/rejected}

## Remaining
{what didn't finish}
```

Update `.company/memory/{dept}.json` with persistent findings from this session.

Report summary to user.

## Namespaced Memory

`.company/memory/{dept}.json` stores persistent knowledge:

```json
{
  "lattice-entropy": "E8 compresses 3.7x vs scalar 1.23x",
  "deflate-result": "5.68x at 3-bit on real KV",
  "shared": {
    "threat-latticequant": "Competitor repo appeared 2026-03-29"
  }
}
```

Agents read their dept's memory at cycle start. Persists across sessions.

## Health Monitoring

If a lead fails:
1. Log to `.company/cycles/cycle-{N}-errors.md`
2. Skip that dept this cycle
3. Retry next cycle with simpler prompt
4. After 3 failures: flag to user

## CEO Override

Write to `.company/memory/shared.json` to inject directives all leads will read.

## Incremental Sessions

On repeat `/company` runs: read STATUS.md + memory/ + latest briefing. Resume from where the company left off.
