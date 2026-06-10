#!/usr/bin/env node

// Stop gate for /company runs. Blocks the session from stopping while any
// criterion in criteria.json is failing or missing evidence.
//
// The ONLY escape hatch is the cancel file: touch .company/CANCEL
// There is deliberately no timing-based escape. A repeated stop attempt is
// blocked again with the same reason until the criteria genuinely pass or
// the run is cancelled.
//
// Fail closed on bad input: unparseable JSON blocks, and so does parseable
// JSON of the wrong shape (criteria not an array, null or non-object
// entries). A gate that throws on malformed state and thereby lets the
// stop through is no gate at all.
//
// Staleness is surfaced, never a free pass: a state file untouched for 24
// hours still blocks, but the block reason states the age in hours and
// points at the cancel file. An unattended timeout that allowed the stop
// would let an abandoned or malformed run end as if it had succeeded, so
// the escape for a genuine leftover stays explicit: touch .company/CANCEL.

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

// Returns a warning suffix for the block reason when the file is stale,
// otherwise an empty string. Never used to allow a stop.
function staleNote(p) {
  try {
    const ms = Date.now() - fs.statSync(p).mtimeMs;
    if (ms > STALE_MS) {
      return ' NOTE: this state file has been untouched for ' +
        Math.round(ms / 3600000) + ' hours. If it is a leftover from an old ' +
        'run, cancel it: touch .company/CANCEL';
    }
  } catch (e) {}
  return '';
}

// No company running
if (!fs.existsSync(goalPath) && !fs.existsSync(criteriaPath)) process.exit(0);

// Cancel signal: the only escape hatch
if (fs.existsSync(cancelPath)) {
  try { fs.unlinkSync(cancelPath); } catch (e) {}
  process.exit(0);
}

if (fs.existsSync(criteriaPath)) {
  const stale = staleNote(criteriaPath);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
  } catch (e) {
    // Fail closed: broken JSON is not a free pass out of the gate.
    block('criteria.json is unparseable. Repair the JSON so the criteria can be ' +
      'checked honestly. To cancel the run instead: touch .company/CANCEL' + stale);
  }

  // Fail closed on the wrong shape too: a parseable file whose criteria
  // field is not an array would otherwise throw below and let the stop slip.
  if (!data || typeof data !== 'object' || !Array.isArray(data.criteria)) {
    block('criteria.json has the wrong shape: "criteria" must be an array of ' +
      '{id, description, passes, evidence} objects. Repair it so the criteria ' +
      'can be checked honestly. To cancel the run instead: touch .company/CANCEL' + stale);
  }

  const all = data.criteria;

  if (all.length === 0) {
    block('criteria.json has zero criteria. Write real yes/no checkable criteria ' +
      'for the goal. To cancel the run instead: touch .company/CANCEL' + stale);
  }

  // passes:true requires non-null evidence. The VERIFY phase writes the
  // reproduced evidence string when it flips a criterion to passing.
  // A null or non-object entry counts as failing, never as a crash.
  const failing = all.filter(c => !c || typeof c !== 'object' || !c.passes || !c.evidence);

  if (failing.length === 0) process.exit(0);

  const failList = failing.map(c =>
    (c && typeof c === 'object' && c.description) ? c.description : '(malformed entry)'
  ).join(', ');
  block(failing.length + '/' + all.length + ' criteria not met: ' + failList +
    '. Continue THINK > EXECUTE > VERIFY. passes:true counts only with non-null ' +
    'evidence reproduced by the reviewer. To cancel the run: touch .company/CANCEL' + stale);
}

// Goal exists but criteria.json was never written
block('Goal not achieved. Create .company/criteria.json and start ' +
  'THINK > EXECUTE > VERIFY. To cancel the run: touch .company/CANCEL' +
  staleNote(goalPath));
