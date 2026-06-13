# Changelog

All notable changes to the /company skill are recorded here. Format follows Keep a Changelog, and the project uses semantic versioning. Versions before 4.6.0 are in the git history and the GitHub releases.

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
