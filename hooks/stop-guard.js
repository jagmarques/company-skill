#!/usr/bin/env node

// Stop gate for /company runs. Blocks the session from stopping while any
// criterion in criteria.json is failing or missing evidence.
//
// The ONLY escape hatch is the cancel file: touch .company/CANCEL
// There is deliberately no timing-based escape. A repeated stop attempt is
// blocked again with the same reason until the criteria genuinely pass or
// the run is cancelled.
//
// Safety valve for unrelated sessions: a criteria.json that has not been
// touched for 24 hours is treated as a stale leftover and does not block.

const fs = require('fs');
const path = require('path');

const companyDir = process.env.COMPANY_DIR || path.join(process.cwd(), '.company');
const criteriaPath = path.join(companyDir, 'criteria.json');
const goalPath = path.join(companyDir, 'GOAL.md');
const cancelPath = path.join(companyDir, 'CANCEL');

const STALE_MS = 24 * 60 * 60 * 1000;

function block(reason) {
  console.log(JSON.stringify({ decision: 'block', reason: '[COMPANY] ' + reason }));
  process.exit(0);
}

function isStale(p) {
  try {
    return Date.now() - fs.statSync(p).mtimeMs > STALE_MS;
  } catch (e) {
    return true;
  }
}

// No company running
if (!fs.existsSync(goalPath) && !fs.existsSync(criteriaPath)) process.exit(0);

// Cancel signal: the only escape hatch
if (fs.existsSync(cancelPath)) {
  try { fs.unlinkSync(cancelPath); } catch (e) {}
  process.exit(0);
}

if (fs.existsSync(criteriaPath)) {
  if (isStale(criteriaPath)) process.exit(0);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
  } catch (e) {
    // Fail closed: broken JSON is not a free pass out of the gate.
    block('criteria.json is unparseable. Repair the JSON so the criteria can be ' +
      'checked honestly. To cancel the run instead: touch .company/CANCEL');
  }

  const all = (data && data.criteria) || [];

  if (all.length === 0) {
    block('criteria.json has zero criteria. Write real yes/no checkable criteria ' +
      'for the goal. To cancel the run instead: touch .company/CANCEL');
  }

  // passes:true requires non-null evidence. The VERIFY phase writes the
  // reproduced evidence string when it flips a criterion to passing.
  const failing = all.filter(c => !c.passes || !c.evidence);

  if (failing.length === 0) process.exit(0);

  const failList = failing.map(c => c.description).join(', ');
  block(failing.length + '/' + all.length + ' criteria not met: ' + failList +
    '. Continue THINK > EXECUTE > VERIFY. passes:true counts only with non-null ' +
    'evidence reproduced by the reviewer. To cancel the run: touch .company/CANCEL');
}

// Goal exists but criteria.json was never written
if (isStale(goalPath)) process.exit(0);
block('Goal not achieved. Create .company/criteria.json and start ' +
  'THINK > EXECUTE > VERIFY. To cancel the run: touch .company/CANCEL');
