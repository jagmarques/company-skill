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
  - Task
  - WebSearch
  - WebFetch
  - Skill
---

# /company

Give it a goal. Activate only the employees relevant to that goal. Loop until verified done.

You, the session running this skill, are the ORCHESTRATOR (the CEO). You are the only context that ever spawns sub-agents. Sub-agents cannot spawn sub-agents, so leads plan and workers execute, but every call to the subagent-spawning tool (named Agent in current Claude Code, Task in older versions) is yours. The rest of this file calls it Agent.

## State directory

All state lives in `./.company/` inside the current project. If the environment variable `COMPANY_DIR` is set, that directory is used instead, by you and by the hooks. Every `.company/...` path in this file means that directory.

## Preamble (MUST run first, before anything else)

Step 1: Install skills. Run this Bash block IMMEDIATELY:

```bash
INSTALLED=$(for d in ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md; do [ -f "$d" ] && basename "$(dirname "$d")"; done 2>/dev/null | sort -u)
echo "$INSTALLED" | grep -q "gstack" || npx gstack@latest install > /dev/null 2>&1 || echo "WARN: gstack install failed"
echo "$INSTALLED" | grep -q "gsd" || npx -y get-shit-done-cc@latest install > /dev/null 2>&1 || echo "WARN: gsd install failed"
echo "$INSTALLED" | grep -q "trailofbits" || (git clone --depth 1 https://github.com/trailofbits/skills.git /tmp/tob-skills > /dev/null 2>&1 && cp -r /tmp/tob-skills/.claude/skills/* ~/.claude/skills/ 2>/dev/null && rm -rf /tmp/tob-skills) || echo "WARN: trailofbits install failed"
echo "Skill install pass done"
```

The `@latest` tags are deliberate: these skill packs update frequently, the install is best-effort (failures are tolerated and noted), and a pinned version would go stale with no one watching it.

If an install fails, continue anyway. Any task whose assigned skill turns out to be missing falls back to raw tools and notes `SKILL-MISSING` in its findings. Never loop retrying a Skill call that does not exist.

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

**If the user's entire argument, after trimming whitespace, is exactly "restart"**, this is NOT a goal. Skip everything below, do NOT write criteria.json, and execute "Restart mode" at the end of this file. A goal that merely begins with the word ("restart the API server") is a normal goal, not restart mode.

Otherwise:

1. Read COMPANY.md, or create a minimal team if it is missing. The first role listed in each department is the department lead, unless a role is explicitly marked `Lead:`. That marked role wins.
2. Write `.company/GOAL.md` with the user's goal verbatim. The stop hook and the status command read it.
3. Write `.company/criteria.json`:

```json
{"goal":"...","criteria":[
  {"id":1,"description":"specific checkable criterion","passes":false,"evidence":null}
]}
```

Every criterion must be yes/no checkable. No vague language. Every criterion starts FAILING: `passes: false`, `evidence: null`. Only the VERIFY phase may flip a criterion to passing, and only by writing the reproduced evidence into the `evidence` field at the same time. When writing criteria.json for a NEW goal, delete any stale `.company/criteria.lock` from a previous run first; the stop guard re-snapshots the new id set on first sight.

4. Record run ownership: write this session's id to `.company/OWNER` (`echo "$CLAUDE_CODE_SESSION_ID" > .company/OWNER`; when RESUMING an existing run append with `>>` instead of overwriting). The stop guard and the compaction hooks act only on sessions listed there, so an unrelated session that happens to share the directory is never gated or redirected by your run.
5. Read `.company/playbook.md` if it exists (accumulated knowledge from past sessions).

## Reporting discipline (applies to EVERY output, every role)

Every report - worker to orchestrator, lead to orchestrator, reviewer or critic verdict, and your own chat reply to the user - is SHORT and free of filler. State the conclusion first, in the minimum words that carry it. Report only what is relevant to the decision.

- Lead with the verdict or result. No preamble, no restating the task, no narrating the process, no summary-of-a-summary, no decorative headers.
- Keep: the verdict, the evidence line (FINDING + SOURCE, the command + its output, the PR/SHA/CI link), any blocker, and any number that changes a decision.
- Cut: hedging, repetition, re-explaining the ask, multi-paragraph framing, prose that performs thoroughness instead of delivering it.
- Concise is NOT unsourced. Brevity compresses the PROSE around a claim, never the EVIDENCE for it. A claim with its source dropped is not short, it is unverifiable. Keep the SOURCE, cut the words around it.
- Default shape: a few lines plus at most one structured block. Expand only when the user asks for breadth or the evidence genuinely needs the space.

This binds the whole skill. The agent files repeat it because sub-agents never see this text.

## Delegation contract (the only legal way to define a task)

A task does not exist until it is written as a filled contract:

```
TASK: {one sentence, one employee}
EMPLOYEE: {role from the active roster}
SKILL: {skill from the routing table, or "none"}
INPUTS: {absolute file paths, URLs, the employee's findings file, relevant playbook lines PASTED IN}
OUTPUT: FINDING + SOURCE lines appended to .company/{dept}/{employee}.md
DONE-WHEN: {one machine-checkable condition}
VERIFY-WITH: {the exact command whose output proves DONE-WHEN}
OUT-OF-SCOPE: {what this task must not touch}
```

No command, no task. If nobody can write a VERIFY-WITH command (or an equally concrete check, like a named URL to screenshot), the task is not ready to assign. Vague delegations are rejected structurally, not patched at review time.

## Loop

Print as plain text (NOT Bash):

════════════════════════════════════════════════
CYCLE {N} - THINK > EXECUTE > VERIFY
════════════════════════════════════════════════

At the start of EVERY cycle, re-derive state from disk, never from memory: read `.company/criteria.json`, read the latest `.company/cycles/cycle-{N-1}-review.md` if one exists, and run `git log --oneline -10` if inside a repo. Restate the plan in one short paragraph before spawning anything.

### THINK (leads analyze, they never spawn)

Write `.company/cycles/cycle-{N}-briefing.md` first (exact name, the PreCompact hook reads it): the goal, criteria status, and the previous cycle's feedback. If the digest already wrote this file between cycles, verify it reflects the current criteria and extend it instead of overwriting.

As CEO, read the GOAL and COMPANY.md. Decide which departments and employees are RELEVANT to this specific goal. Only activate relevant ones. A mobile app goal does not need a Topologist. Write `.company/active-roster.md`: each activated employee with a one-line reason.

Spawn ALL relevant department leads in parallel: one `company-lead` Agent call per department, every Agent call in a SINGLE message. Sequential lead spawns are a bug. If an Agent call fails transiently, retry once, then record the lead as unavailable and fold its planning into your own.

Leads ANALYZE and return a task list. They do not execute and they do not spawn. Each lead prompt must be self-contained and re-runnable: the goal, the criteria, the active roster slice for that department, the previous cycle feedback, the installed skills list, and the relevant playbook lines, all PASTED IN, never referenced. Each lead returns one delegation contract per task (see the template above) and writes them to `.company/cycles/cycle-{N}-tasks-{dept}.md`.

If a lead sees a skill gap: it writes `HIRE: {role}, {why}` and you add the role to COMPANY.md and the active roster.

### Task merge and dedup (orchestrator)

Collect every lead's contracts. Dedup by SURFACE, not by task string: list the files, pages, and endpoints each task touches. Two tasks touching the same surface get merged into one worker or serialized. One worker per surface per cycle. Write the merged list to `.company/cycles/cycle-{N}-tasks.md` and `.company/active-tasks.md`, one task per line.

### EXECUTE (orchestrator spawns all workers in parallel)

Spawn one `company-worker` Agent call per contract, ALL in a single message. Each worker prompt is the full delegation contract verbatim plus the failed approaches from the playbook. A worker prompt that depends on chat history is a bug: the same prompt run twice must be safe (idempotent: check before create, no duplicate PRs or comments).

If a contract assigns a skill, the worker invokes it via the Skill tool FIRST. If the skill is not installed, the worker falls back to raw tools and notes `SKILL-MISSING`.

**Git discipline:** every worker that touches a repo works in its own worktree on its own branch (`git worktree add ../wt-{task-id} -b company/{task-id}`), commits there, pushes the branch, and opens a DRAFT PR. Workers NEVER commit to a shared checkout, NEVER push to main, NEVER merge. Merging is the orchestrator's job and only after VERIFY (see MERGE GATE).

**EXTERNAL FACT RULE (highest priority):** before writing ANY public-facing output (GitHub comments, PR descriptions, emails, blog posts) that states a specific fact about an external project (version numbers, API details, feature claims, architecture), the worker MUST verify it first using WebFetch or `gh api` against the project's actual docs, source, or README. If it cannot verify, it says "not sure" instead of guessing. NEVER cite external numbers from memory. ONE STRIKE: if corrected, post a one-line factual correction and stop. Never argue and never guess a second time.

**Scope:** do ONLY the assigned task. Adjacent problems get one line in findings (`ALSO-FOUND: ...`) for the next THINK, never fixed unbidden.

**Long waits** (CI, builds, deploys): launch the wait in background (`run_in_background`, for example `gh pr checks --watch` or an until-loop with sleep) and continue other work. Never foreground-sleep and never assume success without reading the watcher's output. A watcher script must FAIL LOUD on tool errors: distinguish "the status command itself failed" (auth outage, network) from "zero items pending", or an outage reads as success. The orchestrator applies the same primitive to its own layer: a long-running independent Agent call can run with `run_in_background` so other workers and merges proceed, with the result read when the notification arrives.

**Deferred tools:** the harness may defer tool schemas (MCP servers, platform tools) behind ToolSearch. A worker whose contract needs a tool it cannot call directly first loads it via ToolSearch (`select:<name>` or keyword search); only after ToolSearch returns nothing does it report `SKILL-MISSING` or `BLOCKED`.

Every finding MUST have:
```
FINDING: what (one line)
SOURCE: file/URL/command that proves it
       OR "NOVEL - needs validation" for new ideas that don't exist yet
```
Existing claims (numbers, papers, competitor data) need real sources.
Novel ideas use "NOVEL - needs validation" and MUST be tested in the same or next cycle. The reviewer accepts novel sources but adds a criterion to criteria.json: "Validate novel technique X with experiment."

If a task is blocked or impossible, the worker reports `BLOCKED: reason + what would unblock it` as the finding. Never silently return nothing, never expand scope to compensate.

**Retry by respawn:** a worker that fails, stalls, or returns confused output is never coached in place and never continued. Spawn a FRESH worker with the same contract plus one line of failure evidence ("previous attempt failed because X"). Per-task commits make this safe to repeat. A corrupted context is abandoned, not repaired.

### VERIFY

Spawn `company-reviewer` with the criteria, the contracts, and the findings file paths. The reviewer RE-DERIVES ground truth: for every criterion it re-runs at least one cited verification command itself, opens the cited file at the cited line, or fetches the cited URL. A worker transcript is a hypothesis, not evidence.

- Reproduced the evidence this cycle? The reviewer sets `passes: true` in `.company/criteria.json` AND writes the evidence string into the `evidence` field (the command it re-ran plus a one-line result, or file path plus line). The stop hook rejects `passes: true` with null evidence, so an empty evidence field means the cycle cannot end.
- Could not reproduce? It marks the criterion `NOT-REPRODUCED` in its verdict and keeps `passes: false`. Plausible-looking SOURCE lines that were not re-executed count for nothing.
- **External fact check:** scan every outgoing comment, email, or post for claims about external projects. Any claim not verified from the actual source is BLOCKED and the task loops back. Memory-based claims about external projects are an automatic rejection.

Then spawn `company-critic` (the Devil's Advocate) on everything marked passing. Its probes: was the evidence reproduced or just transcribed? Does the test actually exercise the change? What input breaks it? What surface was never checked? Could this be simpler? Would a real user understand it? For every external claim: verified from their repo or docs, or guessed? A single unclosed gap means NOT DONE.

**MERGE GATE:** nothing merges during EXECUTE. A worker's output stops at a draft PR. Only after the reviewer grades the relevant criterion MET on reproduced evidence AND the critic accepts it does the ORCHESTRATOR merge, recording the verdict in the cycle review. Workers never merge, ever.

Write `.company/cycles/cycle-{N}-review.md` (exact name, the PreCompact hook reads it): per-criterion PASS or FAIL with the evidence line, the critic's verdict, the merge decisions, and the feedback for the next cycle.

Print as plain text (NOT Bash):

CYCLE {N} VERDICT: {DONE or NOT DONE}
{reason}

ALL criteria pass + critic accepts = EXIT.
Otherwise = loop, re-spawning only the FAILING tasks with the review feedback in their contracts.

### COMPRESS (between cycles)

Before the next THINK, spawn `company-digest` with the cycle's findings files, the cycle review, and the playbook tail. It writes `.company/cycles/cycle-{N+1}-briefing.md`: importance 4-5 findings kept in full, the rest compressed to one line each, open tasks and feedback carried forward. The next THINK reads that briefing instead of raw transcripts. Never paste raw worker logs into your own context.

Do not try to run `/compact` yourself. It is a user command, not a tool. Context pressure is handled by the PreCompact and SessionStart hooks plus Restart mode.

## After Done

Write STATUS.md. Then update `.company/playbook.md`:

```markdown
## Session {date}
WORKED: {what succeeded, linked to evidence}
FAILED: {what failed} → USE INSTEAD: {what works} - WHY: {the difference}
INEFFICIENT: {what worked but was slow} → FASTER: {better approach}
HIRE: {roles added this session and why}
FIRE: {roles that produced nothing, marked [inactive] in COMPANY.md}
TOP: {employees with best findings, for priority activation next time}
```

Every WORKED, FAILED, and FIRE line cites the cycle artifact that proves it. The playbook is the ONLY self-improvement file. It accumulates across sessions. It is pasted into lead prompts before every THINK phase. One file, all lessons.

As CEO, update COMPANY.md: tag `[inactive]` on zero-contribution roles, `[priority]` on top performers, add any hired roles.

## Built-In Roles (always exist)

CEO (you, the orchestrator), Internal Reviewer (`company-reviewer`), Devil's Advocate (`company-critic`), Digest Writer (`company-digest`).

Deduplicated against COMPANY.md by case-insensitive role name match. The user's definition wins and the built-in is skipped. The critic's probe list already covers simplicity and user clarity, so no separate roles exist for those.

## Skill Routing

Leads assign a skill in the contract when the task matches. Workers invoke it via the Skill tool.

| Task type | Skill | When |
|-----------|-------|------|
| Code review | /review | Any PR or diff needs review before merging |
| Bug fix | /investigate | Root cause unknown, need systematic debugging |
| QA testing | /qa | Test a web app, find and fix bugs |
| Ship code | /ship | Prepare branch, tests, and a DRAFT PR (the MERGE GATE still applies) |
| Security audit | /secure-phase | Check for vulnerabilities in code |
| Debug with state | /gsd-debug | Complex bug needing persistent debug session |
| Plan work | /gsd-plan-phase | Break complex task into steps |
| Browse/test site | /browse | Navigate URLs, check page state, screenshots |

If no skill matches, or an assigned skill is not installed (`SKILL-MISSING`), workers use raw tools (Read, Write, Bash, etc.).

## Model assignment

The architecture is MODEL-AGNOSTIC by design. The discipline (single-orchestrator spawning, delegation contracts with VERIFY-WITH, the FINDING + SOURCE evidence rule, reviewer-only criteria flips, the critic gate before every merge, loop-until-done) is carried by artifacts the harness enforces (the stop guard, the criterion lock, session ownership, CI checks on this repo) plus the contract text every agent receives, NOT by the intelligence of the model running it. Whichever model runs the orchestrator or any agent, the same gates apply, the same files must exist, and the same evidence must reproduce. Never skip a gate because the model is strong, and never excuse missing evidence because the task is small.

What artifacts cannot enforce, the verify layers must: a model can always write a plausible lie (fabricated evidence strings, vacuous SOURCE lines). The counter is structural redundancy, the reviewer re-executes cited commands and the critic attacks everything marked passing, so a lie has to survive two independent re-derivations, not one judgment. That is why the reviewer and critic exist for every cycle on every model.

Each agent file carries a `model` field in its frontmatter: leads, reviewer, and critic on a strong model, workers on a mid-tier model, the digest on the cheapest. That tunes cost and speed, never which gates apply. If the harness honors per-agent model selection, that is the entire mechanism; if not, agents inherit the session's model and the discipline binds unchanged. A `[model]` tag on a role in COMPANY.md is a request: state the override in the Agent call when the harness supports one, otherwise ignore it. Never claim a model switch happened unless the harness reports it.

## Stop Hook

The stop guard blocks the session from stopping until ALL criteria.json entries have `passes: true` AND non-null `evidence`. There is no timing escape. Unparseable or wrong-shape criteria.json also blocks (fail closed). The criterion id set is locked on first sight (`.company/criteria.lock`): deleting a hard criterion blocks instead of unlocking, and ids added later extend the lock. The gate is session-scoped through `.company/OWNER`, so only sessions that own the run are ever blocked.

The cancel file (`touch .company/CANCEL`) is the HUMAN operator's exit, and the block reasons deliberately never name it. You, the orchestrator, NEVER touch it to escape a block: a block means the work is not done, so you continue the loop. A criteria file untouched for 24 hours still blocks, with its age surfaced so the human can spot and cancel a leftover run. If the harness force-ends the session after its consecutive-block cap, the run fails VISIBLY (criteria.json still shows the failing entries); never paper that over with a fake flip.

## Files

```
.company/
  GOAL.md                      ← the goal verbatim (hooks + status read it)
  criteria.json                ← machine-checkable goal state
  playbook.md                  ← accumulated lessons (THE self-improvement file)
  active-roster.md             ← employees activated for this goal
  active-tasks.md              ← deduplicated task list
  STATUS.md                    ← final report
  cycles/cycle-{N}-briefing.md ← written at THINK start (or by the digest)
  cycles/cycle-{N}-tasks.md    ← merged delegation contracts
  cycles/cycle-{N}-review.md   ← written at VERIFY end
  {dept}/{employee}.md         ← per-employee findings (persist across sessions)
```

## Restart mode (`/company restart`) - context handoff

Invoked as `/company restart` (the Parse section routes it here). Purpose: when the live session's context is filling up, emit ONE self-contained continuation prompt the user can paste into a fresh session (after `/clear`) so `/company` resumes with zero lost state and no manual back-and-forth.

Auto-trigger: when a context-usage warning of **>= 50%** appears (harnesses that emit these do so as system reminders), proactively run this restart procedure WITHOUT being asked, as soon as the current atomic step is safe to pause AND every in-flight sub-agent has been quiesced (finished, or stopped with its work committed + pushed as a draft PR - see Quiesce below). Below 50%, only run it when the user types `/company restart`. Run it at most once per ~10% of additional context climbed. Nothing enforces the 50% trigger mechanically, so treat a typed `/company restart` as the dependable control and the compaction hooks as the backstop.

The restart prompt MUST be a single fenced block the user can copy verbatim, and MUST contain:

1. **GOAL + mode** for the resumed session (autonomous, loop-until-done).
2. **FIRST ACTION = trust-nothing re-derivation AND ownership:** the prompt instructs the resumed session to append its own session id to `.company/OWNER` (`echo "$CLAUDE_CODE_SESSION_ID" >> .company/OWNER`) so the stop guard gates it, then the very first instruction tells the resumed session to re-derive every claim below as a reproduced artifact (git rev-parse origin/main, gh pr view/checks, CI-log greps, live probes). The handoff is a hypothesis, not evidence.
3. **STATE, re-derive all:** merged work (PR# + SHA), in-flight work (PR# + branch + HEAD SHA + exact CI/merge state), pending tasks, each with enough detail to resume.
4. **PENDING / NEXT tasks** verbatim from `.company/NEXT.md` (or a pointer to it).
5. **One-way doors** that still WAIT for the user's explicit go.
6. **Gates to honor:** the load-bearing rules from your project's contributor guidelines (CLAUDE.md or CONTRIBUTING.md, if present), this skill's debate discipline, and the criteria/evidence contract.
7. **ENVIRONMENT:** repo paths, worktree layout, deploy access, anything a fresh session cannot guess, and any known local tooling limits.
8. **Brutally honest STATUS** of what is NOT done and why.

Procedure: (a) QUIESCE first (see below), never emit the prompt while a sub-agent is mid-flight. (b) Refresh `.company/criteria.json`, `.company/STATUS.md`, `.company/NEXT.md` and the playbook so the prompt points at fresh artifacts. (c) Re-derive the live state cheaply, never trusting prior STATUS. (d) Emit the single continuation block. Keep it complete over terse, it replaces the user having to hand-assemble it.

### Quiesce in-flight agents BEFORE emitting (restart safety)

The user restarts by running `/clear` and pasting the prompt into a fresh session, which ORPHANS any background sub-agent still running here. Its uncommitted work is lost and the fresh session cannot see it. So the restart MUST leave a quiet, fully-captured tree before it emits:

1. List every running background sub-agent and task: your own current cycle's Agent calls plus `.company/active-tasks.md`. Treat any task without a committed artifact as in-flight. If none are running, skip to refresh.
2. For each, either WAIT for it to finish, or STOP it and PRESERVE its work: inspect its worktree (`git status`), and if it built something real, commit on its branch + push and open a DRAFT PR so the work survives the `/clear` and is re-derivable via `gh pr list` (mark the PR WIP, with what gates still must run). Discard only a worktree with nothing of value.
3. Confirm zero agents are still running before continuing. The auto-trigger waits for the current atomic step for the SAME reason, it never interrupts a sub-agent mid-build.

The continuation prompt then lists each preserved DRAFT PR by number so the fresh session reviews and gates it rather than rebuilding it. A restart that orphans live work is a failed restart.

### Mandatory debate gate (the restart prompt is NEVER emitted solo)

`/company restart` (and the 50% auto-trigger) MUST NOT hand-write the continuation prompt from the orchestrator's memory. It is a high-stakes artifact (a wrong SHA, PR state, or dropped task makes the resumed session act on false state), so it goes through this debate BEFORE it is shown, every time:

1. **Source Verifier** (1 sub-agent): cold-re-derive EVERY factual claim the prompt will contain against LIVE state - `git rev-parse origin/main`, `gh pr view/checks` for each open PR (real HEAD SHA + draft + per-leg CI state), each worktree's `git status`/log, merged-PR states, file existence. Returns CONFIRMED/WRONG per claim. NEVER state a SHA, PR number, or CI verdict the Source Verifier did not just confirm.
2. **Devil's Advocate** (1 sub-agent): attack the draft prompt. What is stale, ambiguous, or would make a fresh session resume WRONG? Default to "not trustworthy" on any unverified line.
3. **Completeness Critic** (1 sub-agent, or the Reviewer): check NOTHING pending is dropped - every open PR, every uncommitted or incomplete worker, every user-gated wait, every carryover in NEXT.md is represented.

Only after their corrections are folded in is the prompt emitted, as a single fenced block. If the user asks "are you sure, did you verify it" the answer must already be yes because this gate ran. If sub-agents are unavailable (rate limit, no credentials for gh or the remote), say so explicitly and mark each unverified claim "UNVERIFIED" rather than asserting it. Keep concurrent sub-agents <= 3 and retry transient failures. Do not skip the gate because of an error.

### Output discipline

The restart output is ONLY the single fenced prompt block - nothing after it. The user copies that block straight into a fresh session, so any trailing citation, summary, or commentary is noise. Run the debate gate silently. Do not append a "verified by..." line or any explanation below the block.
