# Company

A Claude Code skill that turns a markdown org chart into a running multi-employee company.

Write your team structure in `COMPANY.md`. Type `/company`. Every department activates, employees do their work, and you get a status report of what was accomplished.

## Install

```bash
curl -sL https://raw.githubusercontent.com/jagmarques/company-skill/main/install.sh | bash
```

This installs the skill and creates a `COMPANY.md` template. Edit it with your team, then:

```
/company
```

## How It Works

The company runs in cycles. Each cycle has three phases:

**THINK** — Department leads (Opus) read the priorities, review previous findings, and assign tasks to their team members.

**EXECUTE** — Team members (Sonnet) do the actual work: research, code, review, scan. They use installed skills like `/review`, `/investigate`, `/qa` when available.

**COMPRESS** — A digest writer (Haiku) reads everything that happened and creates a briefing for the next cycle. Only important findings carry forward in full. Routine updates get one line.

This repeats for 3 cycles. Each cycle builds on the last — research findings inform engineering, quality rejections trigger rework, scout alerts cause strategy pivots.

## Write Your Company

Edit `COMPANY.md`:

```markdown
# My Company

## Executive (Lead: CEO)
- CEO — strategy, priorities, conflict resolution
- CTO — technical decisions, architecture

## Engineering (Lead: CTO)
- Backend Developer — API, database
- Frontend Developer — UI, components
- DevOps Engineer — CI/CD, monitoring

## Quality (Lead: QA Lead)
- QA Lead — test strategy, release sign-off
- Security Reviewer — vulnerability analysis

## Priorities
1. [URGENT] Fix checkout payment bug
2. [IMPORTANT] Add user dashboard
3. [RESEARCH] Evaluate caching options

## Rules
- No deploy without QA Lead sign-off
- Security Reviewer must approve auth changes
```

Add as many departments and employees as you need. The skill handles any size.

## Model Assignment

| Phase | Model | Who |
|-------|-------|-----|
| THINK | Opus | Leads, critics, strategists, CEO |
| EXECUTE | Sonnet | Engineers, researchers, scouts, designers |
| COMPRESS | Haiku | Digest writer between cycles |

Override per employee with `[opus]`, `[sonnet]`, or `[haiku]` tags:

```markdown
- ML Scientist — critical experiments [opus]
- Data Entry — log processing [haiku]
```

## Installed Skills

On first run, the skill installs available toolkits so employees can use them:

| Pack | What employees get |
|------|-------------------|
| gstack | /review, /ship, /qa, /investigate, /browse, /office-hours |
| GSD | /gsd:plan-phase, /gsd:execute-phase, /gsd:verify-work |
| trailofbits | Security audit, vulnerability detection |

Also detects marketplace plugins (superpowers, wshobson/agents, oh-my-claudecode) if installed.

All optional. Employees fall back to raw tools if nothing is available.

## Communication

Employees don't share context with each other. They communicate through files:

**Messages** — Each employee writes typed findings to `.company/messages/{dept}.jsonl` with a priority rating (1-5). Only priority 3+ messages reach other departments.

**Briefings** — Between cycles, the digest writer compresses all output into a single briefing file. This is the only thing that carries forward.

**Memory** — Important findings persist in `.company/memory/{dept}.json` across sessions. Next time you run `/company`, employees pick up where they left off.

## What Gets Created

```
.company/
  PRIORITIES.md
  STATUS.md
  memory/
    research.json
    engineering.json
  messages/
    research.jsonl
    quality.jsonl
  cycles/
    cycle-0-briefing.md
    cycle-1-think-research.md
    cycle-1-briefing.md
  research/
    ml-scientist.md
  engineering/
    backend-developer.md
```

## Incremental Sessions

Run `/company` again next session. It reads the previous status, memory, and latest briefing. Departments with no new work are skipped. Employees check their previous findings before re-researching.

## Examples

| File | Team |
|------|------|
| [`startup.md`](examples/startup.md) | 10-person startup |
| [`research-lab.md`](examples/research-lab.md) | Academic research group |
| [`dev-team.md`](examples/dev-team.md) | Software development team |
| [`nexusquant.md`](examples/nexusquant.md) | Full AI research company |

## License

MIT
