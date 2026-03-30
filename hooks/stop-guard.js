#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const criteriaPath = path.join(process.cwd(), '.company', 'criteria.json');
const goalPath = path.join(process.cwd(), '.company', 'GOAL.md');
const cancelPath = path.join(process.cwd(), '.company', 'CANCEL');

if (!fs.existsSync(goalPath) && !fs.existsSync(criteriaPath)) {
  process.exit(0);
}

if (fs.existsSync(cancelPath)) {
  try { fs.unlinkSync(cancelPath); } catch (e) {}
  process.exit(0);
}

if (fs.existsSync(criteriaPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
    const all = data.criteria || [];
    const failing = all.filter(c => !c.passes || !c.evidence);

    if (all.length > 0 && failing.length === 0) {
      process.exit(0);
    }

    const failList = failing.map(c => c.description).join(', ');
    console.log(JSON.stringify({
      decision: "block",
      reason: failing.length + "/" + all.length + " criteria not met: " + failList
    }));
    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
}

const statusPath = path.join(process.cwd(), '.company', 'STATUS.md');
if (fs.existsSync(statusPath)) {
  const status = fs.readFileSync(statusPath, 'utf8');
  if (status.includes('ACHIEVED')) {
    process.exit(0);
  }
}

console.log(JSON.stringify({
  decision: "block",
  reason: "Company goal not yet achieved. Continue cycles."
}));
