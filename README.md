# Company

A Claude Code skill that turns a markdown org chart into a running multi-agent company.

```
COMPANY.md  →  /company  →  THINK → EXECUTE → COMPRESS → loop
```

## The Problem

You want your whole team working together. But shared context explodes tokens, agents go stale, and communication is chaos.

## How It Works

Three tiers running in feedback loops:

```
THINK  (Opus)    Leads decide what to do, critics review
   ↓
EXECUTE (Sonnet)  Workers do the work, use installed skills
   ↓
COMPRESS (Haiku)  Summarize everything into next cycle's briefing
   ↓
   └──── loop back to THINK with new knowledge
```

Each cycle, ALL agents run. Findings from cycle 1 feed cycle 2. Quality rejections trigger rework. Scout alerts cause pivots. Default: 3 cycles per session.

## Quick Start

Install:
```bash
cp -r skill/ .claude/skills/company/
```

Write `COMPANY.md`:
```markdown
# My Team

## Engineering (Lead: CTO)
- CTO — architecture, code review
- Backend Dev — API, database
- Frontend Dev — UI, components

## Quality (Lead: QA Lead)
- QA Lead — test strategy
- Security Reviewer — vulnerability audits

## Priorities
1. [URGENT] Fix checkout bug
2. [IMPORTANT] Add caching layer

## Rules
- No deploy without QA Lead sign-off
```

Run:
```
/company
```

On first run, the skill auto-installs available skill packs (gstack, GSD, superpowers, trailofbits) so agents can use `/review`, `/investigate`, `/ship`, `/qa` etc. Installs are optional — everything works with raw tools too.

## Agent Communication

Agents don't share context. They share files:

- **Messages** — typed JSON in `.company/messages/{dept}.jsonl` with priority ratings
- **Briefings** — compressed summary between cycles in `.company/cycles/`
- **Memory** — persistent findings in `.company/memory/{dept}.json` (survives across sessions)
- **Reports** — per-worker findings in `.company/{dept}/{worker}.md`

Each agent reads only: its task, its department's memory, and the cycle briefing. Context stays small.

## Model Tiers

| Tier | Model | Who |
|------|-------|-----|
| THINK | Opus | Leads, critics, strategists |
| EXECUTE | Sonnet | Workers, engineers, researchers, scouts |
| COMPRESS | Haiku | Digest writer between cycles |

Override any role with `[opus]`, `[sonnet]`, or `[haiku]` tags in COMPANY.md.

## Auto-Installed Skills

On first run, the skill installs what's available:

| Pack | Skills | Source |
|------|--------|--------|
| gstack | /review, /ship, /qa, /investigate, /browse, /office-hours | npx gstack |
| GSD | /gsd:plan-phase, /gsd:execute-phase, /gsd:verify-work | npx gsd-install |
| superpowers | /brainstorm, /write-plan, /execute-plan | obra/superpowers-marketplace |
| trailofbits | Security audit, vulnerability detection | trailofbits/skills |

Also detects marketplace plugins if installed: wshobson/agents, alirezarezvani/claude-skills, oh-my-claudecode.

All optional. Agents fall back to raw tools if nothing installs.

## What Gets Created

```
.company/
├── PRIORITIES.md             # What's being worked on
├── STATUS.md                 # Final synthesis
├── memory/
│   ├── research.json         # Persistent findings (across sessions)
│   └── engineering.json
├── messages/
│   ├── research.jsonl        # Typed messages with priority
│   └── quality.jsonl
├── cycles/
│   ├── cycle-0-briefing.md   # Starting state
│   ├── cycle-1-think-*.md    # Lead decisions
│   ├── cycle-1-briefing.md   # Compressed digest
│   └── ...
└── {department}/
    ├── {worker}.md           # Individual findings (persist)
    └── ...
```

## Incremental Sessions

Next session, `/company` reads STATUS.md + memory/ + latest briefing and resumes. No work is lost. Workers check previous findings before re-researching.

## Examples

| File | Description |
|------|-------------|
| [`startup.md`](examples/startup.md) | 10-person startup |
| [`research-lab.md`](examples/research-lab.md) | Academic group |
| [`dev-team.md`](examples/dev-team.md) | Dev sprint team |
| [`nexusquant.md`](examples/nexusquant.md) | Full AI research company |

## Why Not CrewAI / AutoGen / Ruflo?

| | Company | CrewAI | AutoGen | Ruflo |
|---|---|---|---|---|
| Config | Markdown | Python | Python | TypeScript+YAML |
| Install | Copy 1 file | pip + deps | pip + deps | npm + WASM |
| Runs in | Claude Code | Own process | Own process | Own process |
| Communication | File blackboard | Direct msgs | Group chat | MCP namespace |
| Context/agent | <3K tokens | Shared | Shared | Isolated |
| Persistence | Memory + findings | None | None | SQLite |
| Skills | Auto-installs gstack/GSD/etc | None | None | Built-in |
| Feedback loop | THINK→EXECUTE→COMPRESS | Sequential | Group debate | Queen coordinator |

## License

MIT
