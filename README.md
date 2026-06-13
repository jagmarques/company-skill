# /company

[![npm](https://img.shields.io/npm/v/company-skill)](https://www.npmjs.com/package/company-skill) [![npm downloads](https://img.shields.io/npm/dw/company-skill)](https://www.npmjs.com/package/company-skill) [![CI](https://github.com/jagmarques/company-skill/actions/workflows/check.yml/badge.svg)](https://github.com/jagmarques/company-skill/actions/workflows/check.yml) [![license](https://img.shields.io/npm/l/company-skill)](LICENSE)

**The agent company that can't stop until the work is verified done.**

Your agent stops when it feels done. This makes it stop only when the work is actually done.

```bash
npx company-skill install
```

```
/company "Build a REST API for user management with tests"
```

Optionally define your team first in `COMPANY.md` (skip it and a minimal company is created):

```markdown
## Engineering
- Backend Lead, API design and database architecture
- Frontend Dev, React components and state management
```


## How it works

Every criterion starts failing. Workers run in dependency waves under delegation contracts. At the end of each cycle, the Internal Reviewer re-runs every VERIFY-WITH command and the Devil's Advocate attacks everything marked passing. The stop guard physically blocks exit until every criterion has `passes: true` with reproduced evidence. Once done, `STATUS.md` and a `playbook.md` update are written for the next session.

```
GOAL -> THINK -> EXECUTE (parallel waves) -> VERIFY -> Done?
                                                 |         |
                                               COMPRESS  STATUS.md
                                                 |
                                               THINK (next cycle)
```

**Roles:** CEO orchestrator, Internal Reviewer, Devil's Advocate, Digest Writer. The orchestrator reads `COMPANY.md`, activates only the roles the goal needs, and writes delegation contracts in dependency order. Workers append FINDING + SOURCE lines to findings files. The Digest Writer compresses each finished cycle into the next cycle's briefing so the orchestrator never carries raw worker output in its own context.


## Dashboard

The dashboard starts automatically when you run `/company` and prints its URL in the cycle banner. Each session gets its own port (7000-7999, derived from the session id). Open it in any browser.

```
http://127.0.0.1:7421   <- your session's link, printed at startup
```

```
Company dashboard                            updated 3s ago

Context fill  [===========>    ] 68%  restart due at 50%
              340K / 200K tokens  claude-sonnet-4-6

Company delegation tree              [+] [-] [reset] [fullscreen]
  +-----------+
  |    CEO    |         <- click any node to expand
  +-----------+            its current task and status
     /      \
+-------+  +----------+
|Eng Lead|  |Design Lead|
+-------+  +----------+
  |    \
+----+  +------+
|Dev1|  |Dev2  |
+----+  +------+

Active agents
  Agent             Model           Status   Tokens
  backend-worker    sonnet-4-6      running  12,340
  design-worker     haiku-3-5       done     3,120

Criteria                                       [show details]
  [x] REST endpoints implemented
  [x] Tests pass (pytest: 42 passed)
  [ ] Docs updated
```

What you see, panel by panel:

**Context fill** - the live fill percentage, computed with the same formula the context-guard uses. When the session hits the restart threshold (default 50%), the bar shows "restart due" so you can see the gate before it fires.

**Delegation tree** - SVG tree of orchestrator, department leads, and workers. Click any node to expand its current task and status. Zoom with +/- buttons or the mouse wheel. Drag to pan. Fullscreen button expands it. Zero external JS libraries.

**Active agents** - centered live table of every agent the orchestrator has spawned this session, with model, status, and token count.

**Criteria** - compact progress view with a click-to-expand toggle for the full pass/fail list and reproduced evidence.

The dashboard binds 127.0.0.1 only, reads local files, and sends nothing anywhere. Override the port with `COMPANY_DASHBOARD_PORT`.


## Cost and quality

Multi-agent orchestration buys quality with tokens. /company's answer to the token cost: spend strong-model tokens only where they buy quality, and report the bill every cycle.

**Tiered model delegation.** Each delegation contract carries a `MODEL: cheap|mid|strong` tag. The orchestrator maps the tag to a model at spawn time. Override every sub-agent with `CLAUDE_CODE_SUBAGENT_MODEL` at launch, or write `FORCE_BEST` into `.company/MODEL_POLICY` mid-run.

**Per-cycle cost reporting.** Every cycle produces a `COST:` line in the briefing and a `cycles/cycle-{N}-cost.json` artifact.

**Prompt caching.** Agent prompts are laid out stable-first so repeated spawns hit a shared cache prefix.


## Key features

**Stop guard** - blocks session exit until every criterion has `passes: true` and reproduced evidence. Malformed state blocks rather than fails open. Deleting a hard criterion blocks instead of unlocking. [34-check test](tests/stop-guard.test.js).

**Context-fill guard** - a second Stop hook forces `/company restart` once context reaches the threshold (default 50%). Reads the model id from the transcript to detect the context window. [37-check test](tests/context-guard.test.js).

**Delegation contracts** - a task does not exist without a filled contract. `check-contracts.js` rejects missing fields, vacuous VERIFY-WITH commands, invalid MODEL tiers, and cyclic dependencies. [17-check test](tests/check-contracts.test.js).

**Double verification** - the Internal Reviewer re-runs every VERIFY-WITH command independently. The Devil's Advocate attacks everything marked passing. Two independent reproductions are evidence; one transcript is a hypothesis.

**Git isolation** - workers never push to main and never merge. Every code change lands as a draft PR. The merge gate is yours.

**Pre-push secret scan** - workers run `scripts/secret-scan.js` before any `git push`. Exit 1 blocks the push.

**Codebase graph** - on repos with >200 tracked files, `scripts/codegraph.js` builds a commit-keyed ranked symbol map into `.company/codegraph/` for lead prompts.


## Commands

```
/company "Build X"      Run until X is done
/company                Run using COMPANY.md priorities
/company restart        Emit a verified continuation prompt for a fresh session
/company:status         Show last status
/company:resume         Continue from last session
```


## What gets created

State lives in `./.company/` (relocate with `COMPANY_DIR`):

```
.company/
  GOAL.md          criteria.json     criteria.lock
  playbook.md      active-roster.md  active-tasks.md
  STATUS.md        OWNER             MODEL_POLICY
  CANCEL                             (persistent human exit)
  cycles/          per-cycle briefing, contracts, review, cost
  {dept}/          per-employee findings, persist across sessions
  codegraph/       commit-keyed symbol map (large repos only)
```


## Examples

[`startup.md`](examples/startup.md), [`research-lab.md`](examples/research-lab.md), [`dev-team.md`](examples/dev-team.md), [`nexusquant.md`](examples/nexusquant.md).


## Contributing

```bash
bash scripts/check.sh
```

CI runs the same script on every pull request. Pull requests welcome. Every change lands as a draft PR.


## License

MIT
