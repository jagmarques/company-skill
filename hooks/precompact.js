#!/usr/bin/env node

// Save company state before context compaction so nothing is lost.

const fs = require('fs');
const path = require('path');

const companyDir = path.join(process.cwd(), '.company');
if (!fs.existsSync(companyDir)) process.exit(0);

const checkpoint = {};

// Save current cycle number
const cyclesDir = path.join(companyDir, 'cycles');
if (fs.existsSync(cyclesDir)) {
  const files = fs.readdirSync(cyclesDir).filter(f => f.startsWith('cycle-'));
  const nums = files.map(f => parseInt(f.match(/cycle-(\d+)/)?.[1] || '0'));
  checkpoint.cycle = Math.max(0, ...nums);
}

// Save criteria status
const criteriaPath = path.join(companyDir, 'criteria.json');
if (fs.existsSync(criteriaPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
    const all = data.criteria || [];
    checkpoint.goal = data.goal;
    checkpoint.passing = all.filter(c => c.passes).length;
    checkpoint.total = all.length;
    checkpoint.failing = all.filter(c => !c.passes).map(c => c.description);
  } catch (e) {}
}

// Save active roster
const rosterPath = path.join(companyDir, 'active-roster.md');
if (fs.existsSync(rosterPath)) {
  checkpoint.roster = fs.readFileSync(rosterPath, 'utf8').substring(0, 500);
}

// Write checkpoint
fs.writeFileSync(
  path.join(companyDir, '.checkpoint.json'),
  JSON.stringify(checkpoint, null, 2)
);

process.exit(0);
