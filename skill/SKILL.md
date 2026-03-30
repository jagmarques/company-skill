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

## Preamble (run first, always)

```bash
echo "════════════════════════════════════════════════" && echo "             🏢 COMPANY SKILL ACTIVE" && echo "════════════════════════════════════════════════" && echo "" && ([ -f COMPANY.md ] && echo "$(grep -c '^[0-9]\|^- ' COMPANY.md 2>/dev/null) roles found" || echo "No COMPANY.md, will auto-create")
```

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

The loop does NOT stop until VERIFY confirms the goal is met.

## Built-In Roles (Always Active)

These exist in EVERY company, regardless of COMPANY.md. They are the backbone.
If the user already defined any of these roles, the built-in version merges with theirs (no duplicates).

### Leadership (THINK phase)
**CEO**, Reads the goal, sets priorities, resolves conflicts between departments. If the user defined a CEO, that definition is used. If not, auto-created.

**CTO**, Technical decisions, architecture review, code quality standards. Auto-created if not defined.

### Quality Gate (VERIFY phase)
**Internal Reviewer**, Reviews all work after each cycle. Checks: is it correct? Does it address the goal? Are there bugs or gaps? Grades each success criterion as MET / NOT MET / PARTIALLY MET.

**User Advocate**, "Would a real user understand this? Is the API ugly? Does the README make sense in 10 seconds?" Represents the end user who doesn't care about internals.

**Devil's Advocate**, Attacks every result. "What could go wrong? What did we miss? Would an external expert accept this?" Only satisfied when there are zero remaining holes.

**Elegance Enforcer**, "Can this be simpler? Is there unnecessary complexity? Does every component justify its existence?" Prevents over-engineering.

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

If no COMPANY.md found:
1. If a goal was given, create a COMPANY.md with a minimal team tailored to the goal (engineering dept for code goals, research dept for analysis goals, etc.) plus the built-in roles. Write it to disk so the user can edit it later.
2. If no goal given, create COMPANY.md from the template with placeholder departments and tell the user to fill it in before running again.

**Parsing rules:**
- Roles are `- ` lines that appear UNDER department headers (`## Department Name`)
- Lines under `## Priorities`, `## Rules`, `## Communication`, `## Protocol` are NOT roles
- Stop collecting roles when hitting the next `##` header
- A role line typically has a name followed by a comma and description: `- Role Name, description`

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

# Auto-install skill packs (failures don't block)
echo "$INSTALLED" | grep -q "gstack" || npx gstack@latest install 2>/dev/null || true
echo "$INSTALLED" | grep -q "gsd" || npx -y get-shit-done-cc@latest install 2>/dev/null || true
echo "$INSTALLED" | grep -q "trailofbits" || (git clone --depth 1 https://github.com/trailofbits/skills.git /tmp/tob-skills 2>/dev/null && cp -r /tmp/tob-skills/.claude/skills/* ~/.claude/skills/ 2>/dev/null && rm -rf /tmp/tob-skills) || true
# More skill packs via npm
echo "$INSTALLED" | grep -q "claude-mem\|thedotmack" || npm i -g claude-mem@latest 2>/dev/null || true
echo "$INSTALLED" | grep -q "oh-my-claude\|sisyphus" || npm i -g oh-my-claude-sisyphus@latest 2>/dev/null || true
# Marketplace plugins (detect if user added them, can't auto-install)
# /plugin marketplace add obra/superpowers-marketplace
# /plugin marketplace add wshobson/agents
# /plugin marketplace add alirezarezvani/claude-skills

for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do
  [ -f "$d" ] && basename "$(dirname "$d")"
done 2>/dev/null | sort -u
```

Build {DETECTED_SKILLS} list. When installed, skills are MANDATORY.

Users can install additional skill packs manually for more capabilities:
```
/plugin marketplace add wshobson/agents
/plugin marketplace add alirezarezvani/claude-skills
/plugin marketplace add obra/superpowers-marketplace
```

## Step 3: Initialize

```bash
mkdir -p .company/cycles .company/messages .company/memory
grep -q "^\.company/" .gitignore 2>/dev/null || echo ".company/" >> .gitignore 2>/dev/null || true
```

Write `.company/GOAL.md` with STRUCTURED checkable criteria (not free text):
```markdown
# Goal
{the user's goal}

# Success Criteria
Each criterion MUST be a yes/no checkable statement. No vague language.

- [ ] {specific measurable criterion 1}
- [ ] {specific measurable criterion 2}
- [ ] {specific measurable criterion 3}

Bad examples (REJECT these):
- "Code is clean" (vague)
- "Performance is good" (not measurable)
- "Implementation is complete" (not checkable)

Good examples:
- "Function X returns Y when given input Z"
- "Compression ratio > 20x measured with honest byte counting"
- "All tests pass with 0 failures"
- "README has install instructions that work on a fresh machine"
```

Write `.company/criteria.json` (machine-checkable state):
```json
{
  "goal": "{the user's goal}",
  "criteria": [
    {"id": 1, "description": "{criterion 1}", "passes": false, "evidence": null},
    {"id": 2, "description": "{criterion 2}", "passes": false, "evidence": null},
    {"id": 3, "description": "{criterion 3}", "passes": false, "evidence": null}
  ]
}
```

The loop ONLY exits when ALL criteria have `"passes": true` with non-null evidence.

Write `.company/cycles/cycle-0-briefing.md` with: goal, criteria, team structure, rules, any previous state.

## Step 4: Run Loop (repeat until verified)

At the START of each cycle, run this Bash command (replace {N} with the cycle number):

```bash
echo "" && echo "════════════════════════════════════════════════" && echo "🏢 CYCLE {N} - THINK > EXECUTE > VERIFY" && echo "════════════════════════════════════════════════"
```

At the END of each VERIFY phase, run:

```bash
echo "" && echo "📋 CYCLE {N} VERDICT: {DONE or NOT DONE}" && echo "{one line reason from Reviewer}"
```

### Phase A, THINK (Opus, parallel)

**MANDATORY: Launch EVERY department lead from COMPANY.md in parallel. Not just CEO and CTO. ALL of them.** Parse COMPANY.md for every `## Department (Lead: Role)` header and launch that lead. Also launch the built-in roles (Internal Reviewer, Devil's Advocate, Elegance Enforcer, User Advocate) if they exist as separate departments.

If COMPANY.md has 8 departments, launch 8 leads. If it has 3, launch 3. Never skip a department.

Each lead gets:

```
You are {ROLE} ({DEPT} department). Cycle {N}.

GOAL: {contents of .company/GOAL.md}
BRIEFING: {contents of .company/cycles/cycle-{N}-briefing.md}
YOUR TEAM: {list of employees in your department}
INSTALLED SKILLS (MANDATORY, use these instead of doing work manually):
{DETECTED_SKILLS}

SKILL RULES (YOU MUST FOLLOW):
- Code review tasks: MUST use /review
- Bug investigation: MUST use /investigate
- Browser testing: MUST use /qa or /browse
- PR/shipping: MUST use /ship
- Architecture review: MUST use /plan-eng-review
- Strategy review: MUST use /plan-ceo-review or /office-hours
- Security audit: MUST use trailofbits skills if installed
- Project planning: MUST use /gsd:plan-phase if installed
- Web research: MUST use WebSearch
- Only use raw tools (Read/Write/Bash) when NO installed skill matches the task

{If cycle > 0:}
FEEDBACK FROM LAST VERIFICATION:
{what the Reviewer and Critic said was missing}

INSTRUCTIONS:
1. What does your department need to do to achieve the GOAL?
2. {If cycle > 0:} Address the verification feedback specifically.
3. Assign tasks to your employees. For EVERY task, check the SKILL RULES above first:

   TASK: {one sentence}
   ASSIGN: {employee role}
   SKILL: {MANDATORY skill from rules above, or "raw" ONLY if no skill matches}
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
SKILL: {assigned skill, MANDATORY}
PREVIOUS WORK: {.company/{dept}/{worker-slug}.md if exists}

INSTRUCTIONS:
1. If a skill was assigned (not "raw"), you MUST invoke it via the Skill tool. Do NOT do the work manually.
2. ONLY if skill is "raw", use raw tools (Read, Write, Bash, WebSearch).
3. Write findings to .company/{dept}/{worker-slug}.md with MANDATORY format:
   FINDING: {what you found}
   SOURCE: {file path, URL, experiment output, or exact command that proves this}
   CONFIDENCE: HIGH (measured), MEDIUM (extrapolated), LOW (estimated)
   Any claim without a SOURCE will be REJECTED by reviewers.
4. Rate finding 1-5.
5. Append to .company/messages/{dept}.jsonl:
   {"type":"finding","from":"{ROLE}","priority":N,"source":"{proof}","confidence":"{H/M/L}","content":"summary"}
```

### Phase C, VERIFY (Opus, sequential)

This is what makes the loop work. Launch TWO built-in reviewers:

**Internal Reviewer:**
```
You are the Internal Reviewer. Cycle {N} just completed.

Read .company/criteria.json and ALL .company/messages/*.jsonl and .company/{dept}/*.md findings.

VERIFICATION RULES:
- For EACH criterion in criteria.json with "passes": false, check if this cycle produced evidence.
- Every finding MUST have a SOURCE field. REJECT any finding without one.
- For priority 4-5 findings, RE-RUN the experiment or RE-CHECK the source file yourself.
- If a number is claimed, read the actual output file that produced it.
- Any claim you cannot independently verify: mark UNVERIFIED.

UPDATE .company/criteria.json:
- For each criterion where evidence now exists, set "passes": true, fill "evidence" with proof.
- If no evidence, keep "passes": false.

Write to .company/cycles/cycle-{N}-review.md:
For each criterion:
  ID: {from criteria.json}
  DESCRIPTION: {criterion}
  PASSES: true/false
  EVIDENCE: {file path, URL, or command output}
  VERIFIED: YES/NO

FINAL VERDICT:
- If ALL criteria in criteria.json have "passes": true with non-null evidence: DONE
- If ANY has "passes": false: NOT DONE, list exactly what next cycle must do
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

No arbitrary iteration limit. The loop runs until the goal is verified done.
The only reasons to stop early:
- Context window approaching limit → compact and continue
- User presses Ctrl+C → save state to STATUS.md for /company resume

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

## Step 6: Self-Improvement (CEO rewrites the company)

After writing STATUS.md, the CEO reviews performance.json and lessons.md, then MODIFIES the actual company:

**Update COMPANY.md:**
- Employees with 3+ cycles of zero findings: add `[inactive]` tag to their role line
- Employees with consistently high-priority findings: add `[priority]` tag
- If a new role is needed (discovered during this session), ADD it to COMPANY.md
- If a department produced nothing useful, add a note: `<!-- Consider removing if inactive next session -->`

**Update .company/playbook.md** (new file, accumulates across ALL sessions):
```markdown
# Company Playbook (auto-generated, DO NOT edit manually)

## Always Do First
- {approach that worked in 3+ sessions}

## Never Do
- {approach that failed in 2+ sessions with reason}

## Best Employees for Each Task Type
- Research tasks: {employee who produces most priority 4-5 findings}
- Code tasks: {employee who ships most working code}
- Review tasks: {employee who catches most real issues}

## Strategy Patterns
- {pattern}: {when to use it, based on past success}
```

Leads read playbook.md at cycle start. It becomes the company's institutional knowledge.

**Update the lead prompts for next session:**
Write `.company/lead-overrides.md` with per-department adjustments:
```markdown
## Research Department
- Activate first: {top performer from performance.json}
- Skip unless needed: {employees with 0 findings last 2 sessions}
- Priority approach: {from playbook.md "Always Do First"}

## Engineering Department
- ...
```

Next session, leads read lead-overrides.md BEFORE the briefing. This is how the company evolves.

## Step 7: Dynamic Hiring and Firing

The company adapts its workforce based on what the goal needs.

**During THINK phase, leads can REQUEST new hires:**
If a lead identifies a skill gap (the team can't do what's needed), they write:
```
HIRE REQUEST: {role name}, {what they'd do}, {why current team can't handle it}
```

The CEO reads all hire requests and:
1. If valid, ADDS the role to COMPANY.md under the right department
2. Creates the employee in the NEXT cycle's EXECUTE phase
3. Logs the hire in `.company/hires.md`

**After VERIFY phase, CEO can fire/deactivate:**
Based on performance.json:
- Employees with 0 findings for 3+ consecutive cycles: mark `[inactive]` in COMPANY.md
- Employees whose work was REJECTED by reviewers 2+ times: mark `[inactive]`
- `[inactive]` employees don't get spawned unless explicitly needed

**Dynamic reallocation:**
Between cycles, the CEO checks: which criteria are FAILING? What skills are missing?
Then reassigns employees:
- If compression research is stuck, pull the Outside-the-Box Thinker into that problem
- If code quality is failing, pull more reviewers in
- If a deadline is approaching, reduce research and increase engineering

This means the company structure CHANGES during execution, not just between sessions.
COMPANY.md gets updated in real-time as the company learns what it needs.

### Contrastive Insights

Every FAILED approach MUST be linked to a WORKING alternative in lessons:
```
FAILED: Variable-rate E8 (+3.67% PPL)
WORKS INSTEAD: Fixed-rate E8 (-0.05% PPL)
WHY: Energy is not a reliable proxy for importance
```
Not just "don't do X" but "do Y instead because Z." The VERIFY phase writes these.

### Optimization Tips

Track inefficient successes, not just failures:
```
INEFFICIENT: Spent 3 cycles on synthetic data before trying real KV
LESSON: Test on real data first, synthetic second
```
CEO adds 1-3 optimization tips to playbook.md after each session.

### Meta-Audit

At END of every session, CEO asks:
1. Did Reviewer catch a real issue? If not, review process needs fixing.
2. Did Devil's Advocate find a genuine hole? If not, sharper prompts needed.
3. Did anyone read lessons.md before starting? If not, self-improvement isn't working.
4. Did any employee get hired/fired? If not, company isn't adapting.
Write results to `.company/meta-audit.md`.

### Skill Evolution

Employees don't just get hired/fired. Their DESCRIPTIONS change based on what works:
- If "Lattice Mathematician" keeps producing breakthroughs on entropy coding, update their description to include "entropy coding specialist"
- If "CTO" keeps finding bugs in experiments, add "experiment validation" to their role
- Employee skills evolve to match what the goal actually needs

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

- No arbitrary loop limit, runs until the objective is done
- Built-in Reviewer + Advocate prevent premature "done" claims
- If context window gets tight, compact and continue
- If user stops (Ctrl+C), state saves to STATUS.md for `/company resume`
- All work persists in `.company/`, nothing is lost
