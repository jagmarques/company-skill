# Company

A Claude Code skill that turns a markdown org chart into a running multi-agent system.

```
COMPANY.md  →  /company  →  waves of parallel agents  →  unified status
```

## The Problem

You want your whole team working together. But shared context explodes tokens, agents go stale, and communication is chaos.

## How It Works

```
Wave 1: Department Leads (parallel)          ← 5-6 agents
    ↓ typed messages + reports
Wave 2: Workers for urgent priorities        ← 3-4 per lead, on-demand
    ↓ typed messages + findings
Wave 3: Quality review                       ← 2-3 reviewers
    ↓ verdicts (approved / vetoed)
Wave 4: CEO synthesis                        ← you
```

Each wave starts fresh. Agents in Wave 2 don't inherit Wave 1's context — they read only their task and previous findings. Context stays under 3000 tokens per agent.

Agents communicate through **typed JSON messages**, not free text:

```json
{"type": "finding", "from": "ML Scientist", "priority": 4, "content": "E8 lattice compresses 3.7x better than scalar"}
{"type": "blocker", "from": "Chief Critic", "priority": 5, "content": "MP threshold fails on correlated data"}
{"type": "threat", "from": "GitHub Scout", "priority": 5, "content": "Competitor repo appeared today"}
```

Agents filter by priority >= 3. Low-priority noise never enters their context.

## Quick Start

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

## Key Patterns

### Waves, Not Swarm (from oh-my-claudecode)
Agents run in sequential waves, not all at once. Each wave's output is compressed into files that feed the next wave. Context resets between waves.

### Typed Messages (from Overstory)
13 message types (finding, question, result, blocker, threat, veto, etc.) with priority levels. Agents read only high-priority messages. Low-value noise gets filtered before it enters any context.

### Adaptive Output Budget
Workers self-rate findings 1-5 and write proportionally:

| Rating | Budget |
|--------|--------|
| 1 Nothing new | 50 words |
| 3 Useful finding | 400 words |
| 5 Breakthrough | 1500 words |

No tokens wasted on low-value output.

### Agent Dropout (from ACL 2025)
Track which workers produce high-priority findings. On repeat runs, auto-skip workers that produced nothing useful. 21.6% token savings with improved quality.

### Context Hygiene (from agent_farm)
Each agent gets ONLY: its task, its previous findings, relevant messages (priority >= 3), and rules. Never the full conversation. Under 3000 tokens input per agent.

## What Gets Created

```
.company/
├── PRIORITIES.md
├── STATUS.md
├── messages/
│   ├── engineering.jsonl     ← typed JSON messages
│   ├── quality.jsonl
│   └── research.jsonl
├── engineering/
│   ├── REPORT.md             ← lead's synthesis
│   ├── backend-dev.md        ← worker findings (persist)
│   └── frontend-dev.md
└── quality/
    ├── REPORT.md
    └── security-reviewer.md
```

## Why Not X

| | Company | CrewAI | AutoGen | Overstory | agent_farm |
|---|---|---|---|---|---|
| Config | Markdown | Python | Python | YAML+SQLite | Python |
| Max agents | unlimited (in waves) | ~10 | ~10 | 25 | 50 |
| Communication | Typed JSON | Direct msgs | Group chat | SQLite mail | Filesystem |
| Context per agent | <3K tokens | Shared (100K+) | Shared | Isolated | Isolated |
| Persistence | Findings + messages | None | None | SQLite | None |
| Install | Copy 1 file | pip | pip | pip+SQLite | Clone+tmux |

## Examples

| File | Size |
|------|------|
| [`startup.md`](examples/startup.md) | 10-person startup |
| [`research-lab.md`](examples/research-lab.md) | Academic group |
| [`dev-team.md`](examples/dev-team.md) | Dev sprint team |
| [`nexusquant.md`](examples/nexusquant.md) | Full AI research company |

## License

MIT
