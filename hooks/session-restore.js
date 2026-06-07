#!/usr/bin/env node

// Restore company state after compaction AND drive the /company restart handoff.
// PreCompact cannot make the model emit a prompt (shell-only, no model turn before
// compaction), so the reliable trigger is here: right after compaction the model is
// instructed to run /company restart (its mandatory verify+debate) and emit the handoff.

const fs = require('fs');
const path = require('path');

const companyDir = path.join(process.cwd(), '.company');
if (!fs.existsSync(companyDir)) process.exit(0);

const checkpointMd = path.join(companyDir, '.checkpoint.md');
const checkpointJson = path.join(companyDir, '.checkpoint.json');

let state = '';
if (fs.existsSync(checkpointMd)) {
  state = fs.readFileSync(checkpointMd, 'utf8').substring(0, 2000);
} else if (fs.existsSync(checkpointJson)) {
  try {
    const cp = JSON.parse(fs.readFileSync(checkpointJson, 'utf8'));
    state = "Goal: " + (cp.goal || "unknown") + ", Cycle: " + (cp.cycle || 0) +
      ", Criteria: " + (cp.passing || 0) + "/" + (cp.total || 0) + ".";
  } catch (e) {}
}

// The post-compaction directive: run the restart procedure, do not just "continue".
const directive =
  "[COMPANY] Context was compacted, so prior turn-by-turn state is gone. Before doing " +
  "anything else, run the `/company restart` procedure from the skill: refresh " +
  ".company/{criteria,STATUS,NEXT}.md, run the MANDATORY Source-Verifier + Devil's-Advocate " +
  "+ Completeness debate to re-derive every claim live (trust nothing - CLAUDE.md 1.13), " +
  "then emit ONLY the single self-contained handoff prompt block (no trailing commentary). " +
  "The pre-compaction checkpoint + the pending backlog (incl. any unfinished dashboard / " +
  "frontend / RLS work) are in .company/.checkpoint.md and .company/NEXT.md - read them first.";

const msg = state ? directive + "\n\n--- pre-compaction checkpoint ---\n" + state : directive;
console.log(JSON.stringify({ systemMessage: msg }));
