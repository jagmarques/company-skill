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

# /company, Goal-Driven Multi-Employee Company

Give it a goal. It runs the entire company in loops until the goal is verified done.

```
/company "Build the user authentication system with OAuth2"
/company "Research all competitors and write a competitive analysis"
/company "Fix the payment processing bug and deploy"
```

You set the goal. Walk away. Come back to a STATUS.md with everything accomplished.

## Core Loop

```
GOAL: "{what the user asked for}"
  |
  THINK ── Leads break the goal into tasks, assign to employees
  |
  EXECUTE ── Employees do the work (code, research, scan, test)
  |
  VERIFY ── Built-in Reviewer + Critic check if the goal is actually met
  |
  Done? ── NO: loop back to THINK with feedback on what's missing
         ── YES: write STATUS.md, report to user
```

The loop does NOT stop until VERIFY says the goal is met, or max 5 iterations.

## Built-In Roles (Always Active)

These exist in EVERY company, regardless of COMPANY.md. They are the backbone.
If the user already defined any of these roles, the built-in version merges with theirs (no duplicates).

### Leadership (THINK phase)
**CEO**, Reads the goal, sets priorities, resolves conflicts between departments. If the user defined a CEO, that definition is used. If not, auto-created.

**CTO**, Technical decisions, architecture review, code quality standards. Auto-created if not defined.

### Quality Gate (VERIFY phase)
**Internal Reviewer**, Reviews all work after each cycle. Checks: is it correct? Does it address the goal? Are there bugs or gaps? Grades each success criterion as MET / NOT MET / PARTIALLY MET.

**Devil's Advocate**, Attacks every result. "What could go wrong? What did we miss? Would an external expert accept this?" Only satisfied when there are zero remaining holes.

**Elegance Enforcer**, "Can this be simpler? Is there unnecessary complexity? Does every component justify its existence?" Prevents over-engineering.

**User Advocate**, "Would a real user understand this? Is the API ugly? Does the README make sense in 10 seconds?" Represents the end user who doesn't care about internals.

### Deduplication Rule
When parsing COMPANY.md, check if the user defined roles matching these built-ins:
- Match by name similarity: "CEO", "Chief Executive", "CTO", "Tech Lead", "Reviewer", "Critic", "Advocate", etc.
- If match found: use the USER'S description but ensure the role runs in the correct phase (CEO in THINK, Reviewer in VERIFY)
- If no match: auto-create with default description
- Never duplicate: one CEO, one CTO, one Reviewer, one Advocate, one Elegance Enforcer, one User Advocate

This means a 2-person COMPANY.md (just "Backend Dev" + "Frontend Dev") automatically gets: CEO + CTO + Backend Dev + Frontend Dev + Internal Reviewer + Devil's Advocate + Elegance Enforcer + User Advocate = 8 employees running.

## Step 1: Parse Goal + Company

Read the user's goal from the command argument or their message.

```bash
for f in COMPANY.md company.md; do [ -f "$f" ] && echo "FOUND: $f" && break; done
```

Parse COMPANY.md for departments, roles, priorities, rules. If no COMPANY.md exists, create a minimal company: CEO + one department matching the goal type (engineering for code, research for analysis, etc.) + the two built-in reviewers.

Classify roles:
- **THINK (Opus):** lead, director, chief, CEO, CTO, principal, architect, strategist
- **EXECUTE (Sonnet):** engineer, researcher, scientist, developer, specialist, analyst, scout, designer, writer
- **VERIFY (Opus):** Internal Reviewer + Devil's Advocate (always Opus, verification needs deep reasoning)
- **COMPRESS (Haiku):** auto-created digest writer

Explicit `[opus]`/`[sonnet]`/`[haiku]` tags override defaults.

## Step 2: Install Skills

```bash
INSTALLED=$(for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do
  [ -f "$d" ] && basename "$(dirname "$d")"
done 2>/dev/null | sort -u)

echo "$INSTALLED" | grep -q "gstack" || npx gstack@latest install 2>/dev/null || true
echo "$INSTALLED" | grep -q "gsd" || npx -y get-shit-done-cc@latest install 2>/dev/null || true
echo "$INSTALLED" | grep -q "trailofbits" || (git clone --depth 1 https://github.com/trailofbits/skills.git /tmp/tob-skills 2>/dev/null && cp -r /tmp/tob-skills/.claude/skills/* ~/.claude/skills/ 2>/dev/null && rm -rf /tmp/tob-skills) || true

for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do
  [ -f "$d" ] && basename "$(dirname "$d")"
done 2>/dev/null | sort -u
```

Build {DETECTED_SKILLS} list. Skills are optional power-ups.

## Step 3: Initialize

```bash
mkdir -p .company/cycles .company/messages .company/memory
grep -q "^\.company/" .gitignore 2>/dev/null || echo ".company/" >> .gitignore 2>/dev/null || true
```

Write `.company/GOAL.md`:
```markdown
# Goal
{the user's goal}

# Success Criteria
{inferred from the goal, what does "done" look like?}
```

Write `.company/cycles/cycle-0-briefing.md` with: goal, success criteria, team structure, rules, any previous state.

## Step 4: Run Loop (repeat until verified)

### Phase A, THINK (Opus, parallel)

Launch all department leads in parallel. Each gets:

```
You are {ROLE} ({DEPT} department). Cycle {N}.

GOAL: {contents of .company/GOAL.md}
BRIEFING: {contents of .company/cycles/cycle-{N}-briefing.md}
YOUR TEAM: {list of employees in your department}
AVAILABLE SKILLS: {DETECTED_SKILLS or "raw tools only"}

{If cycle > 0:}
FEEDBACK FROM LAST VERIFICATION:
{what the Reviewer and Critic said was missing}

INSTRUCTIONS:
1. What does your department need to do to achieve the GOAL?
2. {If cycle > 0:} Address the verification feedback specifically.
3. Assign tasks to your employees:

   TASK: {one sentence}
   ASSIGN: {employee role}
   SKILL: {/review, /investigate, /qa, etc. or "raw"}
   CONTEXT: {max 200 words}

4. Write to .company/cycles/cycle-{N}-think-{dept}.md
```

### Phase B, EXECUTE (Sonnet, parallel)

Launch all assigned employees. Each gets:

```
You are {ROLE}. Cycle {N}.

GOAL: {the company's goal, so every employee knows WHY}
TASK: {from lead's assignment}
CONTEXT: {from lead}
SKILL: {assigned skill or "raw"}
PREVIOUS WORK: {.company/{dept}/{worker-slug}.md if exists}

INSTRUCTIONS:
1. If a skill was assigned, use the Skill tool to invoke it.
2. Otherwise use raw tools.
3. Write findings to .company/{dept}/{worker-slug}.md
4. Rate finding 1-5.
5. Append to .company/messages/{dept}.jsonl:
   {"type":"finding","from":"{ROLE}","priority":N,"content":"summary"}
```

### Phase C, VERIFY (Opus, sequential)

This is what makes the loop work. Launch TWO built-in reviewers:

**Internal Reviewer:**
```
You are the Internal Reviewer. Cycle {N} just completed.

GOAL: {from .company/GOAL.md}
SUCCESS CRITERIA: {from .company/GOAL.md}

Read ALL of these:
- All .company/messages/*.jsonl from this cycle
- All .company/{dept}/*.md employee findings
- Any code changes (git diff if applicable)

QUESTION: Has the goal been achieved? Check each success criterion.

Write to .company/cycles/cycle-{N}-review.md:
For each criterion:
  CRITERION: {what was required}
  STATUS: MET / NOT MET / PARTIALLY MET
  EVIDENCE: {what proves it}
  GAPS: {what's still missing}

FINAL VERDICT: DONE or NOT DONE
If NOT DONE: list exactly what the next cycle must fix.
```

**Devil's Advocate:**
```
You are the Devil's Advocate. Your job: find holes.

GOAL: {from .company/GOAL.md}
REVIEWER VERDICT: {from cycle-{N}-review.md}

If the Reviewer said DONE, challenge it:
- Is the work ACTUALLY complete or just surface-level?
- What edge cases were missed?
- Would this survive scrutiny from an external expert?
- Is there anything we're fooling ourselves about?

If the Reviewer said NOT DONE, amplify:
- What's the REAL blocker?
- Is the team approaching this the right way or wasting cycles?

Write to .company/cycles/cycle-{N}-advocate.md:
VERDICT: ACCEPT (goal truly met) or CHALLENGE (not yet)
REASON: {honest assessment}
GAPS: {what's missing, if any}
```

### Phase D, COMPRESS + DECIDE

Launch Haiku digest writer to compress cycle output into next briefing.

Then check:
- Reviewer says DONE **AND** Advocate says ACCEPT → **EXIT LOOP**
- Either says NOT DONE / CHALLENGE → **inject their feedback into next cycle's briefing, continue**
- Reached max 5 iterations → **EXIT with partial status**

## Step 5: Final Report

Write `.company/STATUS.md`:

```markdown
# Company Status, {DATE}
## Goal
{the original goal}

## Verdict: {ACHIEVED / PARTIALLY ACHIEVED / IN PROGRESS}

## What Got Done
{bullet points from all cycles}

## Verification
{Reviewer's final assessment}
{Advocate's final assessment}

## Remaining (if any)
{what didn't get finished}

## Cycles: {N} of 5 max
```

Update `.company/memory/` with persistent findings.

Report to user. If goal was achieved, suggest next steps. If not, explain what's blocking.

## Commands

The skill accepts different forms:

```
/company "Build the auth system"          ← goal-driven, runs until done
/company                                  ← reads priorities from COMPANY.md, runs cycles
/company status                           ← shows .company/STATUS.md without running
/company resume                           ← continues from where last session stopped
```

## Without COMPANY.md

If no COMPANY.md exists, the skill creates a minimal team based on the goal:
- Code/build/fix goals → CEO + CTO + 2 engineers + Internal Reviewer + Devil's Advocate
- Research/analyze goals → CEO + Research Director + 2 researchers + Internal Reviewer + Devil's Advocate
- Review/audit goals → CEO + Lead Reviewer + 2 reviewers + Internal Reviewer + Devil's Advocate

The user doesn't need to configure anything. Just `/company "do this thing"`.

## Namespaced Memory

`.company/memory/{dept}.json` persists findings across sessions. Employees check memory before re-researching.

## Health Monitoring

Failed employees get logged and skipped. After 3 consecutive failures, flagged to user.

## Safety

- Max 5 iterations (prevents infinite loops)
- Each iteration has THINK + EXECUTE + VERIFY (3 phases)
- Built-in Reviewer + Advocate prevent premature "done" claims
- All work persists in `.company/`, nothing is lost if the loop stops
