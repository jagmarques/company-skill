#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const companyDir = path.join(cwd, '.company');
const criteriaPath = path.join(companyDir, 'criteria.json');
const goalPath = path.join(companyDir, 'GOAL.md');
const cancelPath = path.join(companyDir, 'CANCEL');
const lockPath = path.join(companyDir, '.stop-lock');

// No company running
if (!fs.existsSync(goalPath) && !fs.existsSync(criteriaPath)) process.exit(0);

// Cancel signal
if (fs.existsSync(cancelPath)) {
  try { fs.unlinkSync(cancelPath); } catch (e) {}
  try { fs.unlinkSync(lockPath); } catch (e) {}
  process.exit(0);
}

// If lock file exists and is recent (< 60s), this is a repeat stop. Allow it.
if (fs.existsSync(lockPath)) {
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < 60000) {
      fs.unlinkSync(lockPath);
      process.exit(0);
    }
  } catch (e) {}
}

// Check criteria
if (fs.existsSync(criteriaPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
    const all = data.criteria || [];
    const failing = all.filter(c => !c.passes || !c.evidence);

    if (all.length > 0 && failing.length === 0) {
      try { fs.unlinkSync(lockPath); } catch (e) {}
      process.exit(0);
    }

    // Write lock, block this stop
    fs.writeFileSync(lockPath, String(Date.now()));
    const failList = failing.map(c => c.description).join(', ');
    console.log(JSON.stringify({
      decision: "block",
      reason: "[COMPANY] " + failing.length + "/" + all.length + " criteria not met: " + failList + ". Continue THINK > EXECUTE > VERIFY."
    }));
    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
}

// No criteria but goal exists — block once
fs.writeFileSync(lockPath, String(Date.now()));
console.log(JSON.stringify({
  decision: "block",
  reason: "[COMPANY] Goal not achieved. Create criteria.json and start THINK > EXECUTE > VERIFY."
}));
