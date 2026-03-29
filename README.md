# Claude Swarm

A Claude Code skill that turns a markdown file into a running multi-agent company. Write your org chart, type `/swarm`, and every role activates — communicating through a shared blackboard, with smart model routing so critical thinkers get the power they need.

## Why This Exists

Running 40+ AI agents in parallel sounds powerful but burns tokens fast and creates chaos. Claude Swarm solves this with three ideas:

1. **Describe your org in markdown.** No code, no config, no framework. Just a `SWARM.md` file listing departments, roles, and who reports to whom.

2. **Smart model routing.** Not every agent needs the most expensive model. Tag critical roles as `[opus]`, give leads `[sonnet]`, let routine workers run on `[haiku]`. The skill reads your tags and routes accordingly.

3. **Blackboard communication.** Agents don't talk to each other directly (that duplicates context and explodes tokens). They write to a shared board. Each department gets one section. The orchestrator reads the board and makes decisions. Simple, efficient, auditable.

## Install

```bash
# Copy the skill into your Claude Code project
cp -r skill/ .claude/skills/swarm/
```

Or one-liner:
```bash
curl -sL https://raw.githubusercontent.com/jagmarques/claude-swarm/main/install.sh | bash
```

Then in Claude Code:
```
/swarm
```

## Configuration

Create a `SWARM.md` in your project root:

```markdown
# My Company

## Engineering (Lead: CTO)
- CTO — architecture decisions, code review [sonnet]
- Senior Backend — core API, database [sonnet]
- Junior Frontend — UI components [haiku]
- DevOps — CI/CD, infrastructure [haiku]

## Research (Lead: Research Director)
- Research Director — paper strategy [sonnet]
- ML Scientist — experiments, analysis [opus]
- Data Engineer — pipelines, preprocessing [haiku]

## Quality (Lead: QA Lead)
- QA Lead — test strategy [sonnet]
- Security Reviewer — vulnerability analysis [opus]
- Code Reviewer — style, patterns [haiku]
```

### Model Tags

Add `[opus]`, `[sonnet]`, or `[haiku]` to any role to override the default.
**Default: all agents use Opus** for maximum intelligence. Every worker deserves
the best model — smart agents produce better results and waste fewer iterations.

Override selectively when you want to optimize cost:
- `[haiku]` for high-volume routine tasks (scanning, formatting)
- `[sonnet]` for balanced cost/quality

### Communication Rules (Optional)

```markdown
## Rules
- No claim enters production without QA Lead sign-off
- Security Reviewer has veto power
- Research findings go to Engineering before implementation
```

### Priorities (Optional)

```markdown
## Priorities
1. [URGENT] Fix authentication bug in login flow
2. [IMPORTANT] Implement new caching layer
3. [RESEARCH] Evaluate vector database options
```

## How It Works

```
You (CEO) ─── /swarm ───► Skill reads SWARM.md
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
              Research    Engineering  Quality
              Lead [S]    Lead [S]    Lead [S]
                │           │           │
           ┌────┼────┐   ┌──┼──┐     ┌──┼──┐
           ▼    ▼    ▼   ▼  ▼  ▼     ▼  ▼  ▼
          ML  Data  ...  Sr Jr Dev   Sec  CR ...
         [O]  [H]       [S][H][H]   [O] [H]

         Writes to: .swarm/research/    .swarm/quality/
                         │                    │
                         ▼                    ▼
                    ┌─────────────────────────────┐
                    │     BLACKBOARD.md            │
                    │  (shared across all depts)   │
                    └─────────────────────────────┘
                              │
                              ▼
                    CEO synthesizes, decides next
```

**[O]** = Opus &nbsp; **[S]** = Sonnet &nbsp; **[H]** = Haiku

### Execution Flow

1. **Parse** — Skill reads `SWARM.md`, identifies departments, roles, model assignments
2. **Prioritize** — Reads `## Priorities` section (or asks you)
3. **Launch leads** — All department leads spawn in parallel
4. **Leads activate workers** — Each lead decides which team members to wake based on priorities
5. **Workers execute** — Web search, code, analysis — write results to department folder
6. **Leads synthesize** — Each lead writes a report + key findings to blackboard
7. **Quality gate** — Quality department reviews claims from other departments
8. **CEO synthesis** — You get a unified status with accomplished/discovered/threats/next

### Token Efficiency

| Pattern | What Happens | Why It's Worse |
|---------|-------------|----------------|
| All 40 agents in main thread | Context explodes, agents go stale | Shared context = duplicated tokens |
| **Claude Swarm** | **Isolated agents, shared blackboard** | **Each agent reads only what it needs** |

All agents run Opus by default. Token efficiency comes from:
- **Context isolation** — agents only read their department + blackboard, not the full history
- **On-demand activation** — leads only spawn workers for urgent priorities
- **Persistent findings** — workers check previous results before re-researching
- **Incremental runs** — skip departments with no new work (~60% savings)
- **Blackboard brevity** — max 5 lines per department, forces conciseness

## Examples

See `examples/` for ready-to-use company structures:

- **`startup.md`** — 10-person tech startup (CEO, CTO, 3 eng, 2 design, PM, QA, marketing)
- **`research-lab.md`** — Academic research group (PI, 4 researchers, 2 reviewers, 1 writer)
- **`dev-team.md`** — Software development team (tech lead, 5 devs, QA, DevOps)
- **`nexusquant.md`** — 40-person AI research company (the structure that inspired this project)

## File Structure

```
your-project/
├── SWARM.md              # Your company structure (you write this)
├── .swarm/               # Created by the skill (gitignore this)
│   ├── BLACKBOARD.md     # Cross-department communication
│   ├── PRIORITIES.md     # Current session priorities
│   ├── STATUS.md         # Company status after each run
│   ├── research/         # Research department workspace
│   │   ├── REPORT.md
│   │   └── {worker}.md
│   ├── engineering/
│   │   ├── REPORT.md
│   │   └── {worker}.md
│   └── quality/
│       ├── REPORT.md
│       └── {worker}.md
└── .claude/
    └── skills/
        └── swarm/
            └── SKILL.md  # The skill (installed once)
```

## Advanced

### Incremental Runs

On repeat runs, the skill reads `.swarm/STATUS.md` and only re-activates departments with new work. Saves ~60% tokens.

### Custom Communication Rules

The `## Rules` section in `SWARM.md` gets injected into every lead's prompt. Use it for quality gates, approval workflows, or domain-specific constraints.

### Agent Persistence

Workers write findings to `.swarm/{dept}/{worker}.md`. These persist across sessions. Next run, leads check existing findings before spawning workers — avoiding duplicate research.

## Comparison

| Feature | Claude Swarm | CrewAI | AutoGen | MetaGPT | wshobson/agents |
|---------|-------------|--------|---------|---------|----------------|
| Config format | Markdown | Python | Python | JSON | YAML |
| Install | Copy 1 file | pip | pip | pip | Clone repo |
| Runtime | Claude Code native | Separate process | Separate process | Separate process | Claude Code |
| Token efficiency | Model tiering + isolation | Shared context | Shared context | Shared context | Per-agent |
| Agent communication | File blackboard | Direct messages | Group chat | Shared memory | File-based |
| Learning | Persists findings | None | None | None | None |
| Lines of config | 20-50 | 100-500 | 200-1000 | 300+ | 50-200 |

## License

MIT
