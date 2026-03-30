# Company

Give it a goal. The whole company works until it's done.

```
/company "Build the user auth system with OAuth2"
```

A Claude Code skill that reads your team structure from `COMPANY.md`, runs every employee in loops, and doesn't stop until built-in reviewers verify the goal is met.

## Install

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

The loop runs up to 5 iterations. Each cycle builds on the last.

## Built-In Roles

Every company gets these employees automatically, even if your COMPANY.md is empty:

| Role | Phase | What they do |
|------|-------|-------------|
| CEO | THINK | Sets priorities, resolves conflicts |
| CTO | THINK | Technical decisions, architecture |
| Internal Reviewer | VERIFY | Checks work against goal criteria |
| Devil's Advocate | VERIFY | Attacks results, finds holes |
| Elegance Enforcer | VERIFY | Prevents over-engineering |
| User Advocate | VERIFY | Represents the end user |

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
/company "Build X"     Run the company until X is done
/company               Run using priorities from COMPANY.md
/company status        Show last status without running
/company resume        Continue from where last session stopped
```

## Model Assignment

| Phase | Model | Who |
|-------|-------|-----|
| THINK | Opus | CEO, CTO, department leads |
| EXECUTE | Sonnet | Engineers, researchers, scouts |
| VERIFY | Opus | Reviewer, Advocate, Enforcer, User Advocate |
| COMPRESS | Haiku | Digest writer between cycles |

Override per employee: `- ML Scientist, experiments [opus]`

## Installed Skills

On first run, auto-installs available toolkits:

| Pack | What employees get |
|------|-------------------|
| gstack | /review, /ship, /qa, /investigate, /browse |
| GSD | /gsd:plan-phase, /gsd:execute-phase, /gsd:verify-work |
| trailofbits | Security audit, vulnerability detection |

All optional. Falls back to raw tools.

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
