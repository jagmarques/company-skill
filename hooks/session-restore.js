#!/usr/bin/env node

// Restore company state after compaction and drive the /company restart handoff.
// PreCompact cannot make the model emit a prompt (shell-only, no model turn before
// compaction), so the reliable trigger is here: right after compaction the model is
// instructed to run /company restart (its mandatory verify and debate procedure)
// and emit the handoff.
//
// SessionStart context must go through hookSpecificOutput.additionalContext.
// That field reaches the model. systemMessage is a user-facing display only and
// never enters the model's context.

const fs = require('fs');
const path = require('path');

const companyDir = process.env.COMPANY_DIR || path.join(process.cwd(), '.company');
if (!fs.existsSync(companyDir)) process.exit(0);

const checkpointMd = path.join(companyDir, '.checkpoint.md');
let state = '';
if (fs.existsSync(checkpointMd)) {
  state = fs.readFileSync(checkpointMd, 'utf8').substring(0, 2000);
}

// The post-compaction directive: run the restart procedure, do not just "continue".
const directive =
  '[COMPANY] Context was compacted, so prior turn-by-turn state is gone. Before doing ' +
  'anything else, run the /company restart procedure from the skill: refresh ' +
  '.company/criteria.json, .company/STATUS.md and .company/NEXT.md, run the mandatory ' +
  "Source-Verifier + Devil's-Advocate + Completeness debate to re-derive every claim " +
  'live (trust nothing the checkpoint asserts), then emit ONLY the single ' +
  'self-contained handoff prompt block with no trailing commentary. The ' +
  'pre-compaction checkpoint and the pending backlog are in .company/.checkpoint.md ' +
  'and .company/NEXT.md. Read them first.';

const msg = state ? directive + '\n\n--- pre-compaction checkpoint ---\n' + state : directive;
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: msg
  }
}));
