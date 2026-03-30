#!/usr/bin/env node

/**
 * Stop Hook Guard for /company skill.
 *
 * Blocks Claude from stopping until the goal is verified done.
 * Stolen from oh-my-claudecode's persistent-mode pattern.
 *
 * Install: Add to settings.json hooks.Stop
 */

const fs = require('fs');
const path = require('path');

// Check if company skill is active
const goalPath = path.join(process.cwd(), '.company', 'GOAL.md');
const statusPath = path.join(process.cwd(), '.company', 'STATUS.md');

if (!fs.existsSync(goalPath)) {
  // Company not running, allow stop
  process.exit(0);
}

// Check if goal is achieved
if (fs.existsSync(statusPath)) {
  const status = fs.readFileSync(statusPath, 'utf8');
  if (status.includes('ACHIEVED') || status.includes('DONE')) {
    // Goal achieved, allow stop
    process.exit(0);
  }
}

// Check for cancel signal
const cancelPath = path.join(process.cwd(), '.company', 'CANCEL');
if (fs.existsSync(cancelPath)) {
  fs.unlinkSync(cancelPath);
  process.exit(0);
}

// Goal not achieved, block stop and continue
const goal = fs.readFileSync(goalPath, 'utf8');
const output = {
  continue: false,
  stopReason: "Company goal not yet achieved. Continuing cycles.",
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: `The /company goal is NOT yet achieved. Continue the THINK > EXECUTE > VERIFY cycle. Read .company/GOAL.md and the latest cycle briefing to continue.\n\nGoal:\n${goal.substring(0, 500)}`
  }
};

console.log(JSON.stringify(output));
