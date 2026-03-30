---
name: company:status
description: Show current company status without running a cycle
allowed-tools:
  - Read
  - Bash
---

Read and display .company/STATUS.md if it exists. If not, say no company has run yet.
Also show .company/GOAL.md and the latest cycle briefing if they exist.
