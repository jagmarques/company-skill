# Company

Give it a goal. The whole company works until it's done.

```
/company "Build the user auth system with OAuth2"
```

A Claude Code skill that reads your team structure from `COMPANY.md`, runs every employee in loops, and doesn't stop until built-in reviewers verify the goal is met.

## Install

```bash
npx company-skill install
```

Or from git:
```bash
curl -sL https://raw.githubusercontent.com/jagmarques/company-skill/main/install.sh | bash
```

Edit `COMPANY.md` with your team. Or skip it, the skill creates a minimal company automatically.

## How It Works

```
GOAL: "Build the auth system"

  THINK     CEO picks relevant employees, leads assign tasks
  EXECUTE   Employees do the work, use installed skills
  VERIFY    Reviewer checks criteria.json, Advocate attacks results

  Not done? Loop back with feedback.
  Done? Update playbook, write STATUS.md.
```

The loop runs until ALL criteria in `criteria.json` pass. A Stop Hook blocks Claude from exiting early. To cancel: `touch .company/CANCEL`.

## Goal Enforcement

The skill creates `criteria.json` with checkable success criteria:

```json
{"goal":"Build auth","criteria":[
  {"id":1,"description":"OAuth2 login works with Google","passes":false,"evidence":null},
  {"id":2,"description":"All tests pass","passes":false,"evidence":null}
]}
```

The reviewer updates `passes` to `true` with evidence as work completes. The stop hook reads this file and blocks exit until everything passes.

## Self-Improvement

One file: `.company/playbook.md`. Accumulates across sessions.

After each session, the CEO writes:
- WORKED: what succeeded (with evidence)
- FAILED: what failed, USE INSTEAD: what works, WHY: the difference
- INEFFICIENT: what was slow, FASTER: better approach
- TOP: best employees for priority activation next time
- HIRE/FIRE: roles added or deactivated

Leads read the playbook before every THINK phase. Employees check failed approaches before proposing new ones. The company that starts session 5 is smarter than session 1.

The CEO also updates COMPANY.md: tags `[inactive]` on zero-contribution roles, `[priority]` on top performers, adds hired roles, evolves employee descriptions based on what they're good at.

## Built-In Roles

Every company gets these automatically:

| Role | Phase | What they do |
|------|-------|-------------|
| CEO | THINK | Picks relevant employees for the goal, resolves conflicts |
| CTO | THINK | Technical decisions, architecture |
| Internal Reviewer | VERIFY | Checks criteria.json, rejects findings without sources |
| User Advocate | VERIFY | Represents the end user |
| Devil's Advocate | VERIFY | Attacks results, finds holes |
| Elegance Enforcer | VERIFY | Prevents over-engineering |

Deduplicated if you define them in COMPANY.md.

## Source Citations

Every finding needs a source:
- Existing claims: file path, URL, or command output
- Novel ideas: "NOVEL - needs validation" (reviewer adds a validation criterion)

No source = rejected by reviewer.

## Commands

```
/company "Build X"      Run until X is done
/company                Run using COMPANY.md priorities
/company:run "Build X"  Same as above
/company:status         Show last status
/company:resume         Continue from last session
```

## Visual Indicators

```
════════════════════════════════════════════════
             🏢 COMPANY SKILL ACTIVE
════════════════════════════════════════════════

════════════════════════════════════════════════
🏢 CYCLE 1 - THINK > EXECUTE > VERIFY
════════════════════════════════════════════════

📋 CYCLE 1 VERDICT: NOT DONE
Missing validation of compression ratios
```

Employees show with colors: leads (cyan), workers (green), reviewers (yellow), digest (gray).

## Agents

| Agent | Phase | Color |
|-------|-------|-------|
| company-lead | THINK | Cyan |
| company-worker | EXECUTE | Green |
| company-reviewer | VERIFY | Yellow |
| company-critic | VERIFY | Yellow |
| company-digest | COMPRESS | Gray |

## Model Assignment

| Phase | Model | Who |
|-------|-------|-----|
| THINK | Opus | CEO, CTO, leads |
| EXECUTE | Sonnet | Workers |
| VERIFY | Opus | Reviewers |
| COMPRESS | Haiku | Digest writer |

Override per employee: `- ML Scientist, experiments [opus]`

## Installed Skills

Auto-installed on first run:

| Pack | What employees get |
|------|-------------------|
| gstack | /review, /ship, /qa, /investigate, /browse, /office-hours |
| GSD | /gsd:plan-phase, /gsd:execute-phase, /gsd:verify-work, /gsd:debug |
| trailofbits | Security audit, vulnerability detection |

Install manually for more:

```
/plugin marketplace add obra/superpowers-marketplace
/plugin marketplace add wshobson/agents
/plugin marketplace add alirezarezvani/claude-skills
```

When installed, employees MUST use them.

## What Gets Created

```
.company/
  criteria.json        Machine-checkable goal state
  playbook.md          Accumulated lessons (self-improvement)
  active-roster.md     Employees activated for this goal
  active-tasks.md      Deduplicated task list
  STATUS.md            Final report
  cycles/              Per-cycle briefings and reviews
  messages/            Typed findings per department
  {dept}/              Per-employee findings (persist across sessions)
```

## Examples

| File | Team |
|------|------|
| [`startup.md`](examples/startup.md) | 10-person startup |
| [`research-lab.md`](examples/research-lab.md) | Academic group |
| [`dev-team.md`](examples/dev-team.md) | Dev sprint |
| [`nexusquant.md`](examples/nexusquant.md) | Full research company |

## License

MIT
