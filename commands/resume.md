---
name: company:resume
description: Resume company from where last session stopped
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Task
  - WebSearch
  - WebFetch
  - Skill
---

Resume the company from the previous session. Follow ~/.claude/skills/company/SKILL.md exactly.

Re-derive state from disk before acting, never from memory. Read .company/GOAL.md, .company/criteria.json, .company/playbook.md, and the latest cycle briefing and review in .company/cycles/. Treat .company/STATUS.md as a claim, not as truth: verify any merged/in-flight assertions against git log and gh pr list before relying on them.

Then continue the THINK > EXECUTE > VERIFY loop from the first failing criterion.
