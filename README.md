# Company

Run your AI company from a markdown file. One skill. Every role activates.

## What It Does

Write an org chart in `COMPANY.md`. Type `/company` in Claude Code. Every department lead launches in parallel, spawns their workers, and reports back through a shared blackboard. You get a unified status of what was accomplished, discovered, and what to do next.

## Install

```bash
cp -r skill/ .claude/skills/company/
```

Or:
```bash
curl -sL https://raw.githubusercontent.com/jagmarques/company-skill/main/install.sh | bash
```

Then:
```
/company
```

## Write Your Company

Create `COMPANY.md` in your project root:

```markdown
# My Team

## Engineering (Lead: CTO)
- CTO — architecture, code review
- Senior Backend — API, database
- Frontend Dev — UI components
- DevOps — CI/CD, infrastructure

## Research (Lead: Research Director)
- Research Director — strategy, paper writing
- ML Scientist — experiments, analysis
- Data Engineer — pipelines

## Quality (Lead: QA Lead)
- QA Lead — test strategy
- Security Reviewer — vulnerability analysis

## Priorities
1. [URGENT] Ship MVP by Friday
2. [IMPORTANT] Set up monitoring
3. [RESEARCH] Evaluate new framework

## Rules
- No deploy without QA Lead sign-off
- Security Reviewer has veto power
```

That's it. The skill parses departments, identifies leads, launches everything.

## How It Works

```
You ─── /company ───► Reads COMPANY.md
                          │
                ┌─────────┼─────────┐
                ▼         ▼         ▼
          Research    Engineering  Quality
            Lead        Lead        Lead
              │           │           │
         ┌────┼────┐   ┌──┼──┐    ┌──┼──┐
         ▼    ▼    ▼   ▼  ▼  ▼    ▼  ▼  ▼
       Workers...    Workers...   Workers...
              │           │           │
              ▼           ▼           ▼
         ┌────────────────────────────────┐
         │         BLACKBOARD.md          │
         │  (shared across departments)   │
         └────────────────────────────────┘
                      │
                      ▼
              CEO synthesizes
```

1. **Parse** — reads `COMPANY.md`, identifies departments, roles, priorities
2. **Launch leads** — all department leads spawn in parallel
3. **Workers activate** — leads decide who to wake based on priorities
4. **Execute** — workers research, code, review — write to department folder
5. **Synthesize** — leads write reports + key findings to blackboard
6. **Quality gate** — quality department reviews other departments' claims
7. **Status** — you get a unified report of everything

## Token Efficiency

Agents don't share context — they share a blackboard. Each worker reads only its task, writes only its finding. No token explosion.

- **Context isolation** — workers get their task, not the full conversation
- **On-demand activation** — leads only spawn workers for urgent priorities
- **Persistent findings** — previous results reused, no duplicate research
- **Incremental runs** — unchanged departments skip (~60% savings)
- **Blackboard brevity** — max 5 lines per department

All agents use **Opus** by default. Override with `[sonnet]` or `[haiku]` tags on any role.

## File Structure

```
your-project/
├── COMPANY.md              # Your org chart (you write this)
├── .company/               # Created by the skill
│   ├── BLACKBOARD.md       # Cross-department communication
│   ├── PRIORITIES.md       # Session priorities
│   ├── STATUS.md           # What happened
│   └── {department}/       # Per-department workspace
│       ├── REPORT.md       # Lead's synthesis
│       └── {worker}.md     # Individual findings
└── .claude/skills/company/ # The skill (installed once)
```

## Examples

- **`startup.md`** — 10-person tech startup
- **`research-lab.md`** — Academic research group
- **`dev-team.md`** — Software development team
- **`nexusquant.md`** — 40-person AI research company

## Comparison

| | Company | CrewAI | AutoGen | MetaGPT |
|---|---|---|---|---|
| Config | Markdown | Python | Python | JSON |
| Install | 1 file | pip + framework | pip + framework | pip + framework |
| Runs in | Claude Code | Separate process | Separate process | Separate process |
| Communication | Blackboard | Direct messages | Group chat | Shared memory |
| Persistence | Findings saved | None | None | None |

## License

MIT
