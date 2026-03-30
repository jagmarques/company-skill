#!/usr/bin/env node

/**
 * Stop Hook Guard for /company skill.
 * Blocks Claude from stopping until ALL criteria in criteria.json pass.
 * Stolen from oh-my-claudecode's persistent-mode pattern.
 */

const fs = require('fs');
const path = require('path');

const criteriaPath = path.join(process.cwd(), '.company', 'criteria.json');
const goalPath = path.join(process.cwd(), '.company', 'GOAL.md');
const cancelPath = path.join(process.cwd(), '.company', 'CANCEL');

// No company running, allow stop
if (!fs.existsSync(goalPath) && !fs.existsSync(criteriaPath)) {
  process.exit(0);
}

// Cancel signal, allow stop
if (fs.existsSync(cancelPath)) {
  try { fs.unlinkSync(cancelPath); } catch (e) {}
  process.exit(0);
}

// Check criteria.json
if (fs.existsSync(criteriaPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
    const all = data.criteria || [];
    const passing = all.filter(c => c.passes === true && c.evidence);
    const failing = all.filter(c => !c.passes || !c.evidence);

    if (all.length > 0 && failing.length === 0) {
      // All criteria pass, allow stop
      process.exit(0);
    }

    // Some criteria still failing, block stop
    const failList = failing.map(c => `- ${c.description}`).join('\n');
    const output = {
      continue: false,
      stopReason: `${failing.length}/${all.length} criteria not met. Continuing.`,
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: `COMPANY GOAL NOT ACHIEVED. ${failing.length} of ${all.length} criteria still failing:\n${failList}\n\nContinue the THINK > EXECUTE > VERIFY cycle. Read .company/criteria.json and the latest cycle briefing.`
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (e) {
    // criteria.json malformed, allow stop to prevent deadlock
    process.exit(0);
  }
}

// No criteria.json but goal exists, check STATUS.md
const statusPath = path.join(process.cwd(), '.company', 'STATUS.md');
if (fs.existsSync(statusPath)) {
  const status = fs.readFileSync(statusPath, 'utf8');
  if (status.includes('ACHIEVED')) {
    process.exit(0);
  }
}

// Default: block stop
const goal = fs.existsSync(goalPath) ? fs.readFileSync(goalPath, 'utf8').substring(0, 500) : 'Unknown goal';
const output = {
  continue: false,
  stopReason: "Company goal not yet achieved.",
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: `Goal not achieved. Continue cycles.\n\n${goal}`
  }
};
console.log(JSON.stringify(output));
