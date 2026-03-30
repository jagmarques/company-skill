#!/usr/bin/env node

// Restore company state after compaction/resume. Injects context via systemMessage.

const fs = require('fs');
const path = require('path');

const companyDir = path.join(process.cwd(), '.company');
if (!fs.existsSync(companyDir)) process.exit(0);

const checkpointPath = path.join(companyDir, '.checkpoint.json');
if (!fs.existsSync(checkpointPath)) process.exit(0);

try {
  const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const msg = [
    "[COMPANY RESTORED] Session was compacted. Resuming.",
    "Goal: " + (cp.goal || "unknown"),
    "Cycle: " + (cp.cycle || 0),
    "Criteria: " + (cp.passing || 0) + "/" + (cp.total || 0) + " passing",
  ];

  if (cp.failing && cp.failing.length > 0) {
    msg.push("Failing: " + cp.failing.join(", "));
  }

  msg.push("Read .company/criteria.json and continue THINK > EXECUTE > VERIFY.");

  console.log(JSON.stringify({
    systemMessage: msg.join("\n")
  }));
} catch (e) {
  process.exit(0);
}
