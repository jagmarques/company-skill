#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const companyDir = path.join(cwd, '.company');
const criteriaPath = path.join(companyDir, 'criteria.json');
const goalPath = path.join(companyDir, 'GOAL.md');
const cancelPath = path.join(companyDir, 'CANCEL');
const counterPath = path.join(companyDir, '.stop-counter');

// No company running
if (!fs.existsSync(goalPath) && !fs.existsSync(criteriaPath)) {
  process.exit(0);
}

// Cancel signal
if (fs.existsSync(cancelPath)) {
  try { fs.unlinkSync(cancelPath); } catch (e) {}
  process.exit(0);
}

// Circuit breaker: max 10 blocks then allow stop
let count = 0;
try { count = parseInt(fs.readFileSync(counterPath, 'utf8')) || 0; } catch (e) {}
count++;
try { fs.writeFileSync(counterPath, String(count)); } catch (e) {}
if (count > 10) {
  try { fs.unlinkSync(counterPath); } catch (e) {}
  process.exit(0); // Allow stop, prevent infinite loop
}

// Check criteria
if (fs.existsSync(criteriaPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
    const all = data.criteria || [];
    const failing = all.filter(c => !c.passes || !c.evidence);

    if (all.length > 0 && failing.length === 0) {
      try { fs.unlinkSync(counterPath); } catch (e) {}
      process.exit(0); // All pass, allow stop
    }

    const failList = failing.map(c => c.description).join(', ');
    console.log(JSON.stringify({
      continue: false,
      message: "[COMPANY CYCLE] " + failing.length + "/" + all.length + " criteria not met: " + failList + ". Continue THINK > EXECUTE > VERIFY. Read .company/criteria.json."
    }));
    process.exit(0);
  } catch (e) {
    process.exit(0); // Malformed, allow stop
  }
}

// No criteria but goal exists
console.log(JSON.stringify({
  continue: false,
  message: "[COMPANY] Goal not achieved. Read .company/GOAL.md and create criteria.json, then start THINK > EXECUTE > VERIFY."
}));
