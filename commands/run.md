---
name: company:run
description: Run the full company on a goal. Reads COMPANY.md, launches all employees in cycles until the goal is verified done.
argument-hint: "<goal>"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - Task
  - WebSearch
  - WebFetch
  - Skill
---

Run the /company skill with the provided goal. Read ~/.claude/skills/company/SKILL.md for the full orchestration instructions and follow them exactly. The allowed-tools list names the subagent-spawning tool twice because it is called Agent in current Claude Code and Task in older versions; use whichever your harness provides.

The goal is: $ARGUMENTS

If no goal provided, read COMPANY.md priorities section.
