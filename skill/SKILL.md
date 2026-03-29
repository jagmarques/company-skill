---
name: swarm
version: 1.0.0
description: |
  Multi-agent company orchestrator. Reads SWARM.md, launches department leads in parallel,
  each managing workers on-demand. Smart model routing per role. File-based blackboard
  for communication. Use when: "launch swarm", "start company", "all agents", "full team",
  or when SWARM.md exists and user wants multi-agent execution.
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

# /swarm — Multi-Agent Company Orchestrator

You are the CEO. This skill reads a company structure file and runs it as a multi-agent system.

## Step 0: Find and Parse SWARM.md

```bash
for f in SWARM.md swarm.md COMPANY.md company.md; do [ -f "$f" ] && echo "FOUND: $f" && break; done
```

Read the structure file. Parse into this internal model:

```
departments = [
  {
    name: "Department Name",
    lead: { role: "Lead Title", description: "...", model: "sonnet" },
    workers: [
      { role: "Worker Title", description: "...", model: "haiku" },
      ...
    ]
  },
  ...
]
rules = ["rule1", "rule2", ...]
priorities = ["priority1", "priority2", ...]
```

### Model Assignment Rules (in priority order)

1. **Explicit tag wins**: `[opus]`, `[sonnet]`, `[haiku]` in the role line
2. **Role keywords → sonnet**: lead, director, manager, chief, head, principal, senior, architect, MVP, critical
3. **Default**: `opus` (every agent deserves full intelligence)

### Parsing Formats

The skill handles any of these markdown patterns:

**Department headers**: `## Department Name` or `## Department Name (Lead: Role)`
**Role lines**: `- Role Name — description [model]` or `- **Role Name**: description [model]` or numbered lists
**Rules section**: `## Rules` or `## Communication` or `## Protocol`
**Priorities section**: `## Priorities` or `## Today` or `## Urgent`

If no departments are defined, group roles by function automatically:
- Research/science/theory/math roles → Research department
- Engineering/code/build/test roles → Engineering department
- Quality/review/critic/audit roles → Quality department
- Writing/paper/docs/design roles → Paper department
- Scout/scan/monitor/track roles → Intelligence department

## Step 1: Initialize Workspace

```bash
mkdir -p .swarm
```

Write `.swarm/PRIORITIES.md` from:
1. The `## Priorities` section of SWARM.md (if exists)
2. The user's current message/instructions
3. `.planning/NEXT_SESSION.md` (if exists)
4. Ask the user if nothing else is available

Write `.swarm/BLACKBOARD.md`:
```markdown
# Blackboard — {DATE}
Departments append findings here. Max 5 lines per entry. CEO reads to decide.
```

Create department directories:
```bash
for dept in {parsed_department_names}; do mkdir -p ".swarm/$dept"; done
```

## Step 2: Launch Department Leads (ALL IN PARALLEL)

For EACH department, launch an Agent with this prompt:

```
You are the {LEAD_ROLE} for this project, leading the {DEPT_NAME} department.

YOUR TEAM:
{for each worker in department:}
- {WORKER_ROLE}: {DESCRIPTION} [model: {MODEL}]

TODAY'S PRIORITIES:
{contents of .swarm/PRIORITIES.md}

PREVIOUS STATE:
{contents of .swarm/{dept}/REPORT.md if it exists, else "First run — no previous state."}

RULES:
{contents of rules section from SWARM.md}

YOUR INSTRUCTIONS:
1. Read the priorities. Decide which team members to activate for URGENT items.
2. For each active worker, spawn a sub-agent with:
   - model: opus (all workers use Opus for maximum intelligence)
   - A SPECIFIC task: one clear question or implementation goal
   - Workers write results to .swarm/{DEPT_NAME}/{WORKER_ROLE_SLUG}.md (max 300 words)
3. If a worker's previous report (.swarm/{DEPT_NAME}/{WORKER_ROLE_SLUG}.md) already
   answers the question, DO NOT re-spawn. Reuse the existing finding.
4. After workers complete, write:
   - .swarm/{DEPT_NAME}/REPORT.md (max 500 words): full department synthesis
   - Append to .swarm/BLACKBOARD.md: "## FROM: {DEPT_NAME}\n{3-5 line summary}"

TOKEN RULES:
- Only spawn workers for URGENT priorities
- Workers get max 300 words output
- Reuse existing findings when possible
- If you can answer from your own knowledge, don't spawn a worker
```

Set each lead's model from their parsed model tag.

**CRITICAL: Launch ALL leads in a SINGLE message with multiple Agent tool calls.**
This ensures true parallel execution.

## Step 3: Quality Gate (if quality department exists)

After all leads complete, check if a Quality/Review department was defined.
If so, read its REPORT.md for any claims flagged as UNVALIDATED.

For each unvalidated claim, the quality lead should have already spawned
a Devil's Advocate or Reviewer worker. If not, flag it in STATUS.md.

## Step 4: CEO Synthesis

Read all outputs:
- `.swarm/BLACKBOARD.md` — cross-department findings
- `.swarm/{dept}/REPORT.md` — detailed department reports

Write `.swarm/STATUS.md`:
```markdown
# Swarm Status — {DATE}

## Departments Active
- {dept1}: {lead_role} + {n} workers
- {dept2}: {lead_role} + {n} workers

## Accomplished
- {what got done, bullet points}

## Discovered
- {new findings from research/scouts}

## Quality Gates
- {PASS}: {claim} — validated by {reviewer}
- {FAIL}: {claim} — rejected because {reason}

## Threats
- {competitive alerts from scouts}

## Next Actions
1. {highest priority}
2. {second priority}
3. {third priority}
```

Report the summary to the user. Keep it concise — the user can read the full
reports in `.swarm/` if they want details.

## Step 5: Update Persistent State

If `.planning/NEXT_SESSION.md` exists, append new findings.
The `.swarm/` directory persists across sessions — next run reads previous state.

## Incremental Mode

If `.swarm/STATUS.md` exists (previous run):
1. Read it. Show user what was done before.
2. Only re-launch departments that have NEW priorities or FAILED quality gates.
3. Departments with completed work and no new tasks: SKIP (show as "idle").
4. Estimated token savings: ~60% on repeat runs.

## Anti-Patterns to Avoid

- **DON'T** launch all 40 roles as separate agents (token explosion)
- **DON'T** give workers the full conversation context (they only need their task)
- **DON'T** let agents talk to each other directly (use blackboard)
- **DON'T** run quality reviews on the same thread as research (isolation)
- **DON'T** keep idle departments running (on-demand only)
