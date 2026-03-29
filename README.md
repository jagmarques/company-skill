# Company

A Claude Code skill that turns a markdown org chart into a running multi-agent system.

```
COMPANY.md  ──►  /company  ──►  40 agents working in parallel
```

## The Problem

You want 40 AI agents working together — researchers, engineers, critics, scouts. But launching them all in the main thread explodes your context window. Agents go stale. They repeat each other's work. Communication is chaos.

## The Solution

**Company** uses a three-layer architecture:

```
        You (CEO)
            │
     ┌──────┼──────┬──────────┐
     ▼      ▼      ▼          ▼
  Research  Eng   Quality   Scouts     ← Department Leads (parallel)
     │       │      │          │
   ┌─┼─┐  ┌─┼─┐  ┌─┼─┐     ┌─┼─┐
   ▼ ▼ ▼  ▼ ▼ ▼  ▼ ▼ ▼     ▼ ▼ ▼     ← Workers (on-demand)
                    │
              BLACKBOARD.md            ← Shared communication
```

1. **You** set priorities and read the final status
2. **Department leads** launch in parallel, each managing their team
3. **Workers** activate on-demand — only when a lead needs them
4. **Blackboard** is the single communication channel between departments

No agent reads the full conversation. Each gets only its task and the blackboard. That's how you run 40 agents without burning through your context.

## Quick Start

Install the skill:
```bash
cp -r skill/ .claude/skills/company/
```

Write your org chart as `COMPANY.md`:
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

Run it:
```
/company
```

All leads launch in parallel. Each lead reads the priorities, decides which workers to activate, collects their output, and writes findings to the blackboard. You get a unified status report.

## How Agents Communicate

Agents never talk to each other directly. That would duplicate context across every agent.

Instead, every department writes to `.company/BLACKBOARD.md`:

```markdown
## FROM: Engineering
Backend API refactored. Auth endpoint 3x faster. Ready for QA.

## FROM: Quality
Reviewed auth changes. SQL injection vector in line 42. BLOCKED.

## FROM: Research
Found paper on token-based caching. Could replace our Redis layer.
```

The CEO (you) reads the blackboard after all departments report. Department leads also read it to react to other teams' findings.

Workers write detailed results to `.company/{department}/{worker}.md`. These files **persist across sessions** — next time the lead checks existing findings before spawning the same worker again.

## Configuration

### Departments and Roles

The skill parses any markdown structure. Use `##` headers for departments, `-` list items for roles:

```markdown
## Department Name (Lead: Role Name)
- Role Name — what they do
- Another Role — their responsibility
```

The first role or the one marked `(Lead: ...)` becomes the department lead.

### Priorities

```markdown
## Priorities
1. [URGENT] Gets worked on immediately
2. [IMPORTANT] Gets worked on if capacity allows
3. [RESEARCH] Background investigation
```

Leads only spawn workers for items matching their department's expertise.

### Rules

```markdown
## Rules
- Quality department must sign off on all claims
- No code ships without security review
```

Rules get injected into every lead's prompt. Use them for quality gates and approval workflows.

### Model Override

All agents use **Opus** by default. Override per role:

```markdown
- Data Entry Clerk — log processing [haiku]
- Senior Architect — system design [sonnet]
```

## What Gets Created

```
.company/
├── BLACKBOARD.md          # What departments are saying to each other
├── PRIORITIES.md          # What's being worked on this session
├── STATUS.md              # Final synthesis after all departments report
├── engineering/
│   ├── REPORT.md          # Lead's synthesis
│   ├── backend-dev.md     # Worker's findings (persists across sessions)
│   └── frontend-dev.md
└── quality/
    ├── REPORT.md
    └── security-reviewer.md
```

Add `.company/` to your `.gitignore`.

## Incremental Runs

Second time you run `/company`, it reads `.company/STATUS.md` from last time. Departments with no new priorities are skipped. Workers with existing findings aren't re-spawned. Saves ~60% of tokens on repeat runs.

## Examples

See [`examples/`](examples/) for ready-to-use structures:

| File | Description |
|------|-------------|
| `startup.md` | 10-person tech startup |
| `research-lab.md` | Academic research group |
| `dev-team.md` | Software development sprint |
| `nexusquant.md` | 40-person AI research company |

## Why Not CrewAI / AutoGen / MetaGPT?

| | Company | CrewAI | AutoGen | MetaGPT |
|---|---|---|---|---|
| **Configure** | Markdown | Python | Python | JSON |
| **Install** | Copy 1 file | pip + deps | pip + deps | pip + deps |
| **Runs inside** | Claude Code | Own process | Own process | Own process |
| **Communication** | File blackboard | Direct messages | Group chat | Shared memory |
| **Context cost** | Isolated per agent | Shared (explodes) | Shared (explodes) | Shared |
| **Findings persist** | Yes | No | No | No |
| **Lines of config** | 20-50 | 100-500 | 200-1000 | 300+ |

Those frameworks are general-purpose agent orchestrators. **Company** is a Claude Code skill — it works where you already work, with zero infrastructure.

## License

MIT
