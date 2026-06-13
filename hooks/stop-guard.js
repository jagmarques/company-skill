#!/usr/bin/env node

// Stop gate for /company runs: blocks the stop while any criterion fails
// or lacks evidence. Fail closed on bad input (unparseable or wrong-shape
// criteria.json blocks). The cancel file is the HUMAN's exit and block
// reasons never name it. criteria.lock pins the id set: deleting a hard
// criterion blocks instead of unlocking. Staleness is surfaced, never a
// free pass. A harness force-stop leaves the run visibly failed.

const fs = require('fs');
const path = require('path');

const companyDir = process.env.COMPANY_DIR || path.join(process.cwd(), '.company');
const criteriaPath = path.join(companyDir, 'criteria.json');
const goalPath = path.join(companyDir, 'GOAL.md');
const cancelPath = path.join(companyDir, 'CANCEL');
const ownerPath = path.join(companyDir, 'OWNER');

// Session scoping: only sessions listed in .company/OWNER are gated.
// Missing or empty OWNER = legacy state, every session gated (fail closed).
// Manual escape for legacy: ~/.claude/hooks/company-guard-exempt.txt.
let sessionId = null;
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input && typeof input.session_id === 'string') sessionId = input.session_id;
} catch (e) {}
if (sessionId) {
  try {
    const exempt = fs.readFileSync(path.join(
      process.env.HOME || '', '.claude', 'hooks', 'company-guard-exempt.txt'), 'utf8');
    if (exempt.split('\n').some(function (l) { return l.trim() === sessionId; })) process.exit(0);
  } catch (e) {}
  try {
    const rawOwners = fs.readFileSync(ownerPath, 'utf8')
      .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    // Garbled OWNER fails closed: only a clean id list frees a foreign session.
    const valid = rawOwners.filter(function (l) { return /^[A-Za-z0-9][A-Za-z0-9._-]{7,}$/.test(l); });
    if (rawOwners.length > 0 && valid.length === rawOwners.length &&
        valid.indexOf(sessionId) === -1) process.exit(0);
  } catch (e) {}
}

const STALE_MS = 24 * 60 * 60 * 1000;

function block(reason) {
  // Tag the session id so a wrongly gated session can be exempted exactly.
  const tag = sessionId ? ' [session ' + sessionId + ']' : '';
  console.log(JSON.stringify({ decision: 'block', reason: '[COMPANY] ' + reason + tag }));
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
        'run, a human operator can cancel it (see the README)';
    }
  } catch (e) {}
  return '';
}

// No company running
if (!fs.existsSync(goalPath) && !fs.existsSync(criteriaPath)) process.exit(0);

// Persistent human exit. CANCEL present allows the stop. The human removes it to resume.
if (fs.existsSync(cancelPath)) {
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
      'checked honestly.' + stale);
  }

  // Fail closed on the wrong shape too: a parseable file whose criteria
  // field is not an array would otherwise throw below and let the stop slip.
  if (!data || typeof data !== 'object' || !Array.isArray(data.criteria)) {
    block('criteria.json has the wrong shape: "criteria" must be an array of ' +
      '{id, description, passes, evidence} objects. Repair it so the criteria ' +
      'can be checked honestly.' + stale);
  }

  const all = data.criteria;

  if (all.length === 0) {
    block('criteria.json has zero criteria. Write real yes/no checkable criteria ' +
      'for the goal.' + stale);
  }

  // criteria.lock: first sight snapshots ids, removal blocks, additions extend.
  const lockPath = path.join(companyDir, 'criteria.lock');
  const currentIds = all
    .filter(function (c) { return c && typeof c === 'object' && c.id !== undefined && c.id !== null; })
    .map(function (c) { return String(c.id); });
  let lockedIds = null;
  try {
    lockedIds = fs.readFileSync(lockPath, 'utf8')
      .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  } catch (e) {}
  if (lockedIds === null) {
    try { fs.writeFileSync(lockPath, currentIds.join('\n') + '\n'); } catch (e) {}
  } else {
    const missing = lockedIds.filter(function (id) { return currentIds.indexOf(id) === -1; });
    if (missing.length > 0) {
      block('locked criterion id(s) removed from criteria.json: ' + missing.join(', ') +
        '. Criteria are never deleted to satisfy the gate; restore them and meet them.' +
        stale);
    }
    const added = currentIds.filter(function (id) { return lockedIds.indexOf(id) === -1; });
    if (added.length > 0) {
      try { fs.writeFileSync(lockPath, lockedIds.concat(added).join('\n') + '\n'); } catch (e) {}
    }
  }

  // passes:true requires non-null evidence. The VERIFY phase writes the
  // reproduced evidence string when it flips a criterion to passing.
  // A null or non-object entry counts as failing, never as a crash.
  const failing = all.filter(c => !c || typeof c !== 'object' || !c.passes || !c.evidence);

  if (failing.length === 0) process.exit(0);

  // Surface the reviewer's note per failing criterion so the block reason is
  // actionable feedback, not just a name list.
  const failList = failing.map(c => {
    if (!c || typeof c !== 'object') return '(malformed entry)';
    const note = typeof c.note === 'string' && c.note.trim() ? ' [' + c.note.trim().slice(0, 120) + ']' : '';
    return (c.description || '(no description)') + note;
  }).join(', ');
  let goalLine = '';
  try {
    goalLine = fs.readFileSync(goalPath, 'utf8').split('\n').find(function (l) { return l.trim(); }) || '';
    if (goalLine) goalLine = 'GOAL: ' + goalLine.trim().slice(0, 100) + ' | ';
  } catch (e) {}
  block(goalLine + failing.length + '/' + all.length + ' criteria not met: ' + failList +
    '. Continue THINK > EXECUTE > VERIFY. passes:true counts only with non-null ' +
    'evidence reproduced by the reviewer.' + stale);
}

// Goal exists but criteria.json was never written
block('Goal not achieved. Create .company/criteria.json and start ' +
  'THINK > EXECUTE > VERIFY.' +
  staleNote(goalPath));
