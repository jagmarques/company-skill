#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const companyDir = path.join(cwd, '.company');
const criteriaPath = path.join(companyDir, 'criteria.json');
const goalPath = path.join(companyDir, 'GOAL.md');
const cancelPath = path.join(companyDir, 'CANCEL');

// No company running
if (!fs.existsSync(goalPath) && !fs.existsSync(criteriaPath)) process.exit(0);

// Cancel signal
if (fs.existsSync(cancelPath)) {
  try { fs.unlinkSync(cancelPath); } catch (e) {}
  process.exit(0);
}

// Check criteria
if (fs.existsSync(criteriaPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
    const all = data.criteria || [];
    const failing = all.filter(c => !c.passes || !c.evidence);

    if (all.length > 0 && failing.length === 0) process.exit(0);

    const failList = failing.map(c => c.description).join(', ');
    console.log(JSON.stringify({
      decision: "block",
      reason: "[COMPANY] " + failing.length + "/" + all.length + " criteria not met: " + failList + ". Continue THINK > EXECUTE > VERIFY. Read .company/criteria.json."
    }));
    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
}

// No criteria but goal exists
console.log(JSON.stringify({
  decision: "block",
  reason: "[COMPANY] Goal not achieved. Read .company/GOAL.md, create criteria.json, start THINK > EXECUTE > VERIFY."
}));
