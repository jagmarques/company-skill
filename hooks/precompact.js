#!/usr/bin/env node

// Save company state AND reasoning before context compaction.
// Saves both numbers (criteria, cycle) and intent (what we're trying and why).

const fs = require('fs');
const path = require('path');

const companyDir = process.env.COMPANY_DIR || path.join(process.cwd(), '.company');
if (!fs.existsSync(companyDir)) process.exit(0);

// Only sessions that own the run are acted on. A foreign session that merely
// shares the directory must not be redirected or have state written on its
// behalf. Missing or empty OWNER is legacy state and keeps the old behavior.
try {
  const hookInput = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (hookInput && typeof hookInput.session_id === 'string') {
    const owners = fs.readFileSync(path.join(companyDir, 'OWNER'), 'utf8')
      .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (owners.length > 0 && owners.indexOf(hookInput.session_id) === -1) process.exit(0);
  }
} catch (e) {}

const lines = ['# Company Checkpoint (auto-saved before compaction)', ''];

// Goal
const goalPath = path.join(companyDir, 'GOAL.md');
if (fs.existsSync(goalPath)) {
  lines.push('## Goal');
  lines.push(fs.readFileSync(goalPath, 'utf8').substring(0, 500));
  lines.push('');
}

// Cycle number
const cyclesDir = path.join(companyDir, 'cycles');
if (fs.existsSync(cyclesDir)) {
  const files = fs.readdirSync(cyclesDir).filter(f => f.startsWith('cycle-'));
  const nums = files.map(f => parseInt(f.match(/cycle-(\d+)/)?.[1] || '0'));
  const cycle = Math.max(0, ...nums);
  lines.push('## Cycle: ' + cycle);
  lines.push('');

  // Latest briefing (captures current reasoning/intent)
  const briefing = path.join(cyclesDir, `cycle-${cycle}-briefing.md`);
  if (fs.existsSync(briefing)) {
    lines.push('## Current Reasoning');
    lines.push(fs.readFileSync(briefing, 'utf8').substring(0, 1000));
    lines.push('');
  }

  // Latest review (captures what's working/failing)
  const review = path.join(cyclesDir, `cycle-${cycle}-review.md`);
  if (fs.existsSync(review)) {
    lines.push('## Latest Review');
    lines.push(fs.readFileSync(review, 'utf8').substring(0, 500));
    lines.push('');
  }
}

// Criteria status
const criteriaPath = path.join(companyDir, 'criteria.json');
if (fs.existsSync(criteriaPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
    const all = data.criteria || [];
    lines.push('## Criteria: ' + all.filter(c => c.passes).length + '/' + all.length + ' passing');
    for (const c of all) {
      lines.push('- [' + (c.passes ? 'x' : ' ') + '] ' + c.description);
    }
    lines.push('');
  } catch (e) {}
}

// Active roster
const rosterPath = path.join(companyDir, 'active-roster.md');
if (fs.existsSync(rosterPath)) {
  lines.push('## Active Roster');
  lines.push(fs.readFileSync(rosterPath, 'utf8').substring(0, 300));
  lines.push('');
}

// Playbook (accumulated lessons). New session entries are appended at the
// bottom, so snapshot the TAIL, not the head.
const playbookPath = path.join(companyDir, 'playbook.md');
if (fs.existsSync(playbookPath)) {
  const playbook = fs.readFileSync(playbookPath, 'utf8');
  lines.push('## Playbook (latest lessons)');
  lines.push(playbook.substring(Math.max(0, playbook.length - 500)));
  lines.push('');
}

lines.push('## Next Action');
lines.push('Read .company/criteria.json and continue THINK > EXECUTE > VERIFY.');

fs.writeFileSync(path.join(companyDir, '.checkpoint.md'), lines.join('\n'));
process.exit(0);
