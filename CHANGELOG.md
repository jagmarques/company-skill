# Changelog

All notable changes to the /company skill are recorded here. Format follows Keep a Changelog, and the project uses semantic versioning. Versions before 4.6.0 are in the git history and the GitHub releases.

## 4.6.4

### Fixed
- companyDir resolution in all 4 hooks (context-guard, stop-guard, precompact, session-restore)
  and in scripts/restart-debate.js, scripts/reset-company-guard.js, scripts/dashboard.js.
  Previously every file used `process.env.COMPANY_DIR || path.join(process.cwd(), '.company')`,
  so when the orchestrator cd'd into a repo the hooks read the wrong .company dir, splitting
  run state (OWNER, criteria.json, NEXT.md, cycles/ all live in ~/.company but hooks read
  repo/.company). Fix: COMPANY_DIR env wins; else check cwd/.company for an OWNER file, then
  $HOME/.company for an OWNER file, and prefer the dir that contains OWNER. If both contain
  OWNER, cwd/.company wins (project-local run is not hijacked by $HOME). If neither contains
  OWNER, fall back to cwd/.company (new-run default, preserving original behavior).

## 4.6.3

### Changed
- Perspective-diverse verify for high-stakes criteria (SKILL.md VERIFY). This extends the
  skill's own restart-debate 3-role panel and Anthropic's evaluator-optimizer/fresh-verifier
  pattern to in-loop high-stakes criteria (tagged `stakes: high` in criteria.json). For those
  criteria only, the orchestrator spawns three fresh-context critics, each with a distinct LENS
  directive (correctness, security, reproducibility). Any REJECT blocks. Normal-stakes criteria
  keep the single critic unchanged. This is not a verbatim Anthropic recipe: it generalizes our
  own restart panel pattern applied one stage earlier in the loop.
- Completeness probe sharpened (company-critic.md probe 4). The prior single line "what surface
  was never checked" is replaced with an explicit enumerate-and-mark step: the critic lists every
  surface the GOAL names or implies, marks each CHECKED or UNCHECKED, and auto-REJECTs any
  in-scope UNCHECKED surface. Out-of-scope gaps become PROPOSE lines. Directly extends
  Anthropic's "verify against the specification" pattern from the Fable 5 guidance.
- Judge-panel for design decisions (company-lead.md). For criteria tagged `kind: design` in
  criteria.json, the lead may emit N<=3 independent contracts from materially different angles
  plus 1 synthesis contract. Reserved for genuine design forks: if the lead cannot name 2+
  materially different angles, it is not a design fork and the single path is used. This is the
  parallel-attempts-then-synthesize pattern from the multi-agent coverage literature, with an
  explicit anti-bloat reserve clause.
- Effort/model allocation couples stakes to ROI (SKILL.md Effort scaling, one clause). The
  existing "Tie effort to ROI" sentence now reads "Tie effort to ROI and stakes", making explicit
  that strong/high-effort spawn is warranted by either high value or high risk, not ROI alone.

## 4.6.2

### Changed
- Anti-fabrication line added to worker, reviewer, and critic agent files, and referenced once in
  SKILL.md. Each agent now explicitly audits every factual claim against a tool result from the
  current session before reporting it. Closes the verbatim anti-fabrication gap in the Anthropic
  Fable 5 guidance for long-horizon autonomous runs.
- Async-first guidance added to the EXECUTE/Loop section. Independent agents in a wave should be
  launched with run_in_background so the orchestrator continues rather than blocking at a barrier.
  Blocking joins are reserved for genuine cross-dependencies. Extends the existing long-waits
  run_in_background primitive to cover independent worker waves.
- Split-long-contracts guidance added to EXECUTE. A single mega-contract bypasses the reviewer and
  critic interval. The orchestrator should prefer two shorter contracts or add a mid-contract
  checkpoint. Guidance only, not a hard gate.
- Send-to-user note added to COMPRESS. Mid-run deliverables meant for a watching human should be
  surfaced via the harness send-to-user capability where available, not buried in findings.
- Token cost discipline opening sentence removed (it restated the Reporting discipline evidence
  floor verbatim). The four specific sub-items are unchanged. Trimming reduces over-prescription
  per the Anthropic Fable 5 guidance that highly prescriptive prompts can degrade output quality.

## 4.6.1

### Changed
- Reflect-after-tool guidance added to worker, reviewer, and critic. After every tool or command
  returns, agents check whether the result proves what was needed before the next action, not after.
  This closes the adaptive-thinking/interleaved-reflection gap documented in the Anthropic Fable 5
  guidance for multi-step agentic loops.
- Narrate-action-not-reasoning fix across SKILL.md and all three agent files. The prior wording
  asked agents to "narrate intent" which can trip the reasoning_extraction refusal on Fable 5 and
  cause a silent fallback to a weaker model. Agents now state the action and its target (what, to
  what) without transcribing internal reasoning.
- Thinking/reflection section added to SKILL.md. Documents that `budget_tokens` is deprecated on
  Claude 4.6+ and unsupported on Fable 5 - reflection depth is model-controlled, not a parameter.
- Effort note added to the Model assignment section of SKILL.md. The cheap/mid/strong contract
  intent maps to lower/default/higher effort on models that expose an `effort` control (Fable 5
  default is high). The harness does not set effort automatically; it is a launch-time control.

## 4.6.0

### Added
- Tiered model delegation. Each delegation contract carries a lead-justified `MODEL: cheap|mid|strong` tag mapped to a model at spawn time. No role hardcodes a model, the strong roles inherit the session model, and `.company/MODEL_POLICY` switches a live run between FORCE_BEST and TIERED. Per-cycle token cost is reported in the briefing and STATUS.md (#24).
- Codebase graph with commit-keyed enforced freshness. On repos above 200 tracked files, `scripts/codegraph.js` builds a ranked symbol map and refuses to emit a stale map unless `--allow-stale` labels it, so planning never runs on unmarked stale structure (#26).
- Localhost observability dashboard. `node scripts/dashboard.js` serves a zero-dependency page on 127.0.0.1 with live token cost, approximate savings, active agents, the company hierarchy, and criteria progress. It reads local files and sends nothing anywhere (#27).
- Proactive security. A pre-push secret scan that degrades gracefully when no scanner is installed, an untrusted-content rule that treats fetched content as data and not instructions, and a checkpoint injection fence on the precompact and session-restore hooks (#29).

### Changed
- GitHub Actions pinned to commit SHAs with least-privilege workflow permissions (#25).
- Skill preamble installs pinned to reviewed upstream refs (gstack, get-shit-done-cc, trailofbits) with a `COMPANY_SKILLS=latest` opt-in escape, so a poisoned upstream release does not auto-run on a /company invocation (#30).
- README rewritten for adoption with the shipped capabilities, every claim cold-verified against the merged skill (#31).

### Fixed
- The stop-guard CANCEL is now persistent. It was single-use and got consumed on the first stop attempt, which could loop a run forever when a criterion could only be met by a human (#28).
- The four guard holes a red-team battle-test found: deleting `criteria.lock` to re-snapshot a reduced criteria set, a session rewriting `OWNER` to evict itself, a length-only VERIFY-WITH check, and a bare `SOURCE:` passing the findings gate. The lock and ownership state now anchor outside the project directory (#29).

### Architecture
- ROI-maximizing proactivity threaded through the full architecture: delegation contracts carry a required `ROI:` field so leads justify value-over-effort; the lead ranks contracts by ROI and the orchestrator waves them highest-value-first; workers deliver the best-achievable result within scope (not just the minimum that clears DONE-WHEN) and surface high-value adjacent opportunities via `PROPOSE:`; the critic gains probe 9 (did the worker take the highest-ROI approach or just the minimum?); the reviewer's EFFICIENCY dimension now explicitly flags ignored higher-ROI paths. One-worker-per-surface and do-only-assigned-task guardrails are restated so this does not become scope creep.
