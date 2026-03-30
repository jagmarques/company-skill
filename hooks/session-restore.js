#!/usr/bin/env node

// Restore company state after compaction. Reads the checkpoint with reasoning + state.

const fs = require('fs');
const path = require('path');

const companyDir = path.join(process.cwd(), '.company');
if (!fs.existsSync(companyDir)) process.exit(0);

const checkpointMd = path.join(companyDir, '.checkpoint.md');
const checkpointJson = path.join(companyDir, '.checkpoint.json');

let msg = null;

if (fs.existsSync(checkpointMd)) {
  msg = fs.readFileSync(checkpointMd, 'utf8').substring(0, 2000);
} else if (fs.existsSync(checkpointJson)) {
  try {
    const cp = JSON.parse(fs.readFileSync(checkpointJson, 'utf8'));
    msg = "[COMPANY RESTORED] Goal: " + (cp.goal || "unknown") +
      ", Cycle: " + (cp.cycle || 0) +
      ", Criteria: " + (cp.passing || 0) + "/" + (cp.total || 0) +
      ". Read .company/criteria.json and continue.";
  } catch (e) {}
}

if (msg) {
  console.log(JSON.stringify({ systemMessage: msg }));
}
