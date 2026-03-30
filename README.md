# Company

Give it a goal. The whole company works until it's done.

```
/company "Build the user auth system with OAuth2"
```

A Claude Code skill that reads your team structure from `COMPANY.md`, runs every employee in loops, and doesn't stop until built-in reviewers verify the goal is met.

## Install

npm:
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

  THINK     Leads break the goal into tasks
  EXECUTE   Employees do the work
  VERIFY    Built-in Reviewer + Critic check if the goal is met

  Not done? Loop back with feedback on what's missing.
  Done? Write STATUS.md, report to user.
```

No arbitrary limit. The loop runs until ALL criteria in `criteria.json` pass. A Stop Hook blocks Claude from exiting early. To cancel: `touch .company/CANCEL`.

## Built-In Roles

Every company gets these employees automatically, even if your COMPANY.md is empty:

| Role | Phase | What they do |
|------|-------|-------------|
| CEO | THINK | Sets priorities, resolves conflicts |
| CTO | THINK | Technical decisions, architecture |
| Internal Reviewer | VERIFY | Checks work against goal criteria |
| User Advocate | VERIFY | Represents the end user |
| Devil's Advocate | VERIFY | Attacks results, finds holes |
| Elegance Enforcer | VERIFY | Prevents over-engineering |

If you define these roles in COMPANY.md, the skill uses your description instead. No duplicates.

A minimal `/company "fix the login bug"` with no COMPANY.md runs: CEO + CTO + 2 auto-created engineers + 4 built-in reviewers = 8 employees.

## Write Your Company

`COMPANY.md` adds your own employees on top of the built-ins:

```markdown
# My Team

## Executive (Lead: CEO)
- CEO, product vision, customer focus
- CTO, architecture, technical standards

## Engineering (Lead: CTO)
- Backend Developer, API, database
- Frontend Developer, UI, components
- DevOps Engineer, CI/CD, monitoring

## Priorities
1. [URGENT] Fix payment processing
2. [IMPORTANT] Add user dashboard

## Rules
- No deploy without review
```

## Commands

```
/company "Build X"      Run the company until X is done
/company                Run using priorities from COMPANY.md
/company:run "Build X"  Same as /company "Build X"
/company:status         Show last status without running
/company:resume         Continue from where last session stopped
```

Installs globally. Works from any directory.

## Visual Indicators

When the skill runs, you see:

```
════════════════════════════════════════════════
             🏢 COMPANY SKILL ACTIVE
════════════════════════════════════════════════

════════════════════════════════════════════════
🏢 CYCLE 1 - THINK > EXECUTE > VERIFY
════════════════════════════════════════════════

📋 CYCLE 1 VERDICT: NOT DONE
Missing validation of compression ratios

════════════════════════════════════════════════
🏢 CYCLE 2 - THINK > EXECUTE > VERIFY
════════════════════════════════════════════════

📋 CYCLE 2 VERDICT: DONE
All success criteria met
```

Employees show with colors: leads (cyan), workers (green), reviewers (yellow), digest (gray). Skills are mandatory when installed.

## Agents

| Agent | Phase | Color | Role |
|-------|-------|-------|------|
| company-lead | THINK | Cyan | Department leads, deciding what to do |
| company-worker | EXECUTE | Green | Employees doing the actual work |
| company-reviewer | VERIFY | Yellow | Internal Reviewer, checking quality |
| company-critic | VERIFY | Yellow | Devil's Advocate, finding holes |
| company-digest | COMPRESS | Gray | Compresses output between cycles |

## Model Assignment

| Phase | Model | Who |
|-------|-------|-----|
| THINK | Opus | CEO, CTO, department leads |
| EXECUTE | Sonnet | Engineers, researchers, scouts |
| VERIFY | Opus | Reviewer, Advocate, Enforcer, User Advocate |
| COMPRESS | Haiku | Digest writer between cycles |

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
npm i -g claude-mem
npm i -g oh-my-claude-sisyphus
```

When installed, employees MUST use them. Raw tools only when no skill matches the task.

## What Gets Created

```
.company/
  GOAL.md
  STATUS.md
  memory/{dept}.json
  messages/{dept}.jsonl
  cycles/
    cycle-0-briefing.md
    cycle-1-think-{dept}.md
    cycle-1-review.md
    cycle-1-advocate.md
    cycle-1-briefing.md
  {dept}/{employee}.md
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
