---
name: company
description: |
  Goal-driven multi-employee company. Give it a goal, it runs until done.
  Reads COMPANY.md for team structure. Built-in quality reviewers.
  Use when: "launch company", "start company", "all employees", or /company "goal".
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

# /company

Give it a goal. Run every employee. Loop until verified done.

## Preamble (MUST run first, before anything else)

Step 1: Install skills. Run this Bash block IMMEDIATELY:

```bash
INSTALLED=$(for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do [ -f "$d" ] && basename "$(dirname "$d")"; done 2>/dev/null | sort -u)
echo "$INSTALLED" | grep -q "gstack" || npx gstack@latest install > /dev/null 2>&1 || true
echo "$INSTALLED" | grep -q "gsd" || npx -y get-shit-done-cc@latest install > /dev/null 2>&1 || true
echo "$INSTALLED" | grep -q "trailofbits" || (git clone --depth 1 https://github.com/trailofbits/skills.git /tmp/tob-skills > /dev/null 2>&1 && cp -r /tmp/tob-skills/.claude/skills/* ~/.claude/skills/ 2>/dev/null && rm -rf /tmp/tob-skills) || true
echo "Skills installed"
```

Step 2: Print banner as plain text (NOT Bash):

```
═════════════════════════════════════════════════════════════════════
 ██████    ██████   ███    ███  ██████    █████   ██    ██  ██    ██
██        ██    ██  ████  ████  ██   ██  ██   ██  ███   ██   ██  ██
██        ██    ██  ██ ████ ██  ██████   ███████  ██ ██ ██    ████
██        ██    ██  ██  ██  ██  ██       ██   ██  ██   ███     ██
 ██████    ██████   ██      ██  ██       ██   ██  ██    ██     ██
═════════════════════════════════════════════════════════════════════
```

Then check if COMPANY.md exists and report how many roles found. Check if playbook.md exists.

## Parse

Read COMPANY.md (or create minimal team if missing). Read the user's goal.

Write `.company/criteria.json`:
```json
{"goal":"...","criteria":[
  {"id":1,"description":"specific checkable criterion","passes":false,"evidence":null}
]}
```
Every criterion must be yes/no checkable. No vague language.

Read `.company/playbook.md` if it exists (accumulated knowledge from past sessions).

## Loop

Print as plain text (NOT Bash):

════════════════════════════════════════════════
CYCLE {N} - THINK > EXECUTE > VERIFY
════════════════════════════════════════════════

### THINK (Opus, all leads parallel)

First, CEO reads the GOAL and COMPANY.md. Decide which departments and employees are RELEVANT to this specific goal. Only activate relevant ones. A mobile app goal doesn't need a Topologist. A math research goal doesn't need DevOps.

Write `.company/active-roster.md`: list of employees activated for THIS goal with a one-line reason why each is relevant.

Then launch ALL relevant department leads in parallel (skip departments with zero relevant employees).

Each lead gets: goal, criteria, playbook (if exists), active roster, previous cycle feedback, their team list, installed skills list.

Leads assign tasks. For each task: one sentence, one employee, one skill (if installed).

If a lead sees a skill gap: write `HIRE: {role}, {why}` and CEO adds it to COMPANY.md and active roster.
If a lead realizes an idle employee is needed after all: add them to active roster.

### EXECUTE (Sonnet, all workers parallel)

Each worker gets: their task, their previous findings file, failed approaches from playbook.

If a skill was assigned (see Skill Routing table), invoke it via the Skill tool FIRST before doing anything else.

**EXTERNAL FACT RULE (highest priority):** Before writing ANY public-facing output (GitHub comments, PR descriptions, emails, blog posts) that states a specific fact about an external project (version numbers, API details, feature claims, architecture, block formats), the worker MUST verify it first using WebFetch or `gh api` to read the project's actual docs/source/README. If it cannot verify, it must say "not sure" instead of guessing. NEVER cite external numbers from memory. ONE STRIKE: if corrected, respond "my bad, you're right" and stop — never attempt a second correction with more guessed details.

Every finding MUST have:
```
FINDING: what
SOURCE: file/URL/command that proves it
       OR "NOVEL - needs validation" for new ideas/techniques that don't exist yet
```
Existing claims (numbers, papers, competitor data) need real sources.
Novel ideas (new techniques, hypotheses, untested approaches) use "NOVEL - needs validation" and MUST be tested in the same or next cycle. The reviewer accepts novel sources but adds a criterion to criteria.json: "Validate novel technique X with experiment."

### VERIFY (Opus)

Internal Reviewer reads criteria.json + all findings. For each criterion:
- Evidence exists with source? Set passes: true in criteria.json
- No evidence or source missing? Keep passes: false
- **External fact check:** Scan every outgoing comment/email/blog for claims about external projects (numbers, percentages, technical details, feature comparisons). If any claim wasn't verified from the actual source (repo, docs, README), BLOCK the output and send the worker back to verify. Memory-based claims about external projects = automatic rejection.

Devil's Advocate attacks anything marked as passing. **Specifically for external claims:** ask "did you actually verify this from their repo/docs, or are you guessing?" for every statement about a competitor or external project.

Print as plain text (NOT Bash):

CYCLE {N} VERDICT: {DONE or NOT DONE}
{reason}

ALL criteria pass + Advocate accepts = EXIT.
Otherwise = loop with feedback.

Between cycles: if context is getting long (3+ cycles), run `/compact` to free space before next THINK phase.

### Task Deduplication

Before EXECUTE, CEO reads all task assignments from all leads. If two employees got the same task, remove the duplicate. Write `.company/active-tasks.md` with one task per line so nobody works on the same thing.

## After Done

Write STATUS.md. Then update `.company/playbook.md`:

```markdown
## Session {date}
WORKED: {what succeeded, linked to evidence}
FAILED: {what failed} → USE INSTEAD: {what works} — WHY: {the difference}
INEFFICIENT: {what worked but was slow} → FASTER: {better approach}
HIRE: {roles added this session and why}
FIRE: {roles that produced nothing, marked [inactive] in COMPANY.md}
TOP: {employees with best findings, for priority activation next time}
```

The playbook is the ONLY self-improvement file. It accumulates across sessions. Leads read it before every THINK phase. One file, all lessons.

CEO updates COMPANY.md: tag `[inactive]` on zero-contribution roles, `[priority]` on top performers, add any hired roles.

## Built-In Roles (always exist)

CEO, CTO, Internal Reviewer, User Advocate, Devil's Advocate, Elegance Enforcer.
Deduplicated if user defines them in COMPANY.md.

## Skill Routing

Leads MUST assign a skill when the task matches. Workers MUST invoke it via the Skill tool.

| Task type | Skill | When |
|-----------|-------|------|
| Code review | /review | Any PR or diff needs review before merging |
| Bug fix | /investigate | Root cause unknown, need systematic debugging |
| QA testing | /qa | Test a web app, find and fix bugs |
| Ship code | /ship | Create PR, run tests, push |
| Security audit | /secure-phase | Check for vulnerabilities in code |
| Debug with state | /gsd-debug | Complex bug needing persistent debug session |
| Plan work | /gsd-plan-phase | Break complex task into steps |
| Browse/test site | /browse | Navigate URLs, check page state, screenshots |

If no skill matches, workers use raw tools (Read, Write, Bash, etc.).

## Stop Hook

Claude cannot stop until ALL criteria.json entries have passes: true.
Cancel: `touch .company/CANCEL`

## Files

```
.company/
  criteria.json    ← machine-checkable goal state
  playbook.md      ← accumulated lessons (THE self-improvement file)
  STATUS.md        ← final report
  cycles/          ← per-cycle briefings and reviews
  messages/        ← typed findings per department
  {dept}/          ← per-employee findings (persist across sessions)
```
