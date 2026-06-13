#!/usr/bin/env node

// Stop gate for /company runs: blocks the stop while any criterion fails
// or lacks evidence. Fail closed on bad input (unparseable or wrong-shape
// criteria.json blocks). The cancel file is the HUMAN's exit and block
// reasons never name it. criteria.lock pins the id set: deleting a hard
// criterion blocks instead of unlocking. Staleness is surfaced, never a
// free pass. A harness force-stop leaves the run visibly failed.
//
// External anchor (3d + 4d fix): enforcement state is mirrored to
// ~/.claude/company-guard-state/<key>/ where key = sha256(realpath(companyDir)).slice(0,16).
// The external lock is authoritative for criteria.lock, the external owners log is
// append-only and makes OWNER rewrite-eviction impossible. Degrades gracefully
// when ~/.claude is unwritable (falls back to .company-only behavior, no crash).
//
// SECURITY INVARIANT: a locked id removed from criteria.json ALWAYS blocks, with
// no heuristic escape. There is NO in-guard self-heal. Any file-state heuristic
// (mtime, content hash, goal text) is bypassable by an in-run actor that can write
// .company/ files. The correct way to clear a stale anchor for a new goal is the
// deliberate reset in scripts/reset-company-guard.js (run by a human or the
// orchestrator at parse time, never triggered automatically by stop-guard).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const companyDir = process.env.COMPANY_DIR || path.join(process.cwd(), '.company');
const criteriaPath = path.join(companyDir, 'criteria.json');
const goalPath = path.join(companyDir, 'GOAL.md');
const cancelPath = path.join(companyDir, 'CANCEL');
const ownerPath = path.join(companyDir, 'OWNER');

function getAnchorDir() {
  try {
    const real = fs.realpathSync(companyDir);
    const key = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
    const home = process.env.HOME || '';
    return path.join(home, '.claude', 'company-guard-state', key);
  } catch (e) {
    return null;
  }
}

// Lazily create the anchor dir, returns null if ~/.claude is unwritable (degrade path).
function ensureAnchorDir(anchorDir) {
  if (!anchorDir) return null;
  try {
    fs.mkdirSync(anchorDir, { recursive: true });
    return anchorDir;
  } catch (e) {
    return null;
  }
}

const anchorDir = getAnchorDir();

// Session scoping: only sessions listed in .company/OWNER are gated.
// Missing or empty OWNER = legacy state, every session gated (fail closed).
// Manual escape for legacy: ~/.claude/hooks/company-guard-exempt.txt.
// 4d fix: effective owner set = (.company/OWNER union external owners log).
// A session once recorded as an owner cannot evict itself by rewriting OWNER.
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
    if (rawOwners.length > 0 && valid.length === rawOwners.length) {
      if (valid.indexOf(sessionId) !== -1) {
        // Session is in current OWNER - record it to the external owners log (append-only, dedup).
        const ad = ensureAnchorDir(anchorDir);
        if (ad) {
          const ownersLogPath = path.join(ad, 'owners');
          try {
            const existing = fs.existsSync(ownersLogPath)
              ? fs.readFileSync(ownersLogPath, 'utf8').split('\n').map(function (l) { return l.trim(); }).filter(Boolean)
              : [];
            if (existing.indexOf(sessionId) === -1) {
              fs.appendFileSync(ownersLogPath, sessionId + '\n');
            }
          } catch (e) {}
        }
        // Session is an owner - do NOT exit 0 here, fall through to the criteria check.
      } else {
        // Session is not in current OWNER. Check external owners log before treating as foreign.
        let inExternalOwners = false;
        if (anchorDir) {
          try {
            const ownersLogPath = path.join(anchorDir, 'owners');
            const extOwners = fs.readFileSync(ownersLogPath, 'utf8')
              .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
            inExternalOwners = extOwners.indexOf(sessionId) !== -1;
          } catch (e) {}
        }
        // Foreign only if absent from both OWNER and external log.
        if (!inExternalOwners) process.exit(0);
      }
    }
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

  // criteria.lock: 3d fix - external lock is authoritative.
  // If the external lock exists, it is the source of truth (rm .company/criteria.lock
  // becomes a no-op, .company lock is healed from the external copy). If the external
  // lock is missing this is a genuine first sight.
  //
  // NO self-heal: a locked id removed from criteria.json BLOCKS unconditionally.
  // There is no file-state heuristic (mtime, content hash, GOAL text) that can
  // distinguish a legitimate new-goal run from an in-run tamper, because the same
  // in-run actor that writes criteria.json can also write GOAL.md (sibling files).
  // Use scripts/reset-company-guard.js to deliberately clear a stale anchor when
  // starting a new goal. That is an explicit, auditable action, not a silent heal.
  const lockPath = path.join(companyDir, 'criteria.lock');
  const extLockPath = anchorDir ? path.join(anchorDir, 'lock') : null;
  const currentIds = all
    .filter(function (c) { return c && typeof c === 'object' && c.id !== undefined && c.id !== null; })
    .map(function (c) { return String(c.id); });

  // Try to read the external lock first (authoritative).
  let lockedIds = null;
  if (extLockPath) {
    try {
      lockedIds = fs.readFileSync(extLockPath, 'utf8')
        .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (lockedIds.length === 0) lockedIds = null;
    } catch (e) {}
  }

  if (lockedIds !== null) {
    // External lock exists - heal the .company copy in case it was deleted.
    try { fs.writeFileSync(lockPath, lockedIds.join('\n') + '\n'); } catch (e) {}
  } else {
    // Fall back to .company lock (degrade path when external anchor unavailable).
    try {
      const raw = fs.readFileSync(lockPath, 'utf8')
        .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (raw.length > 0) lockedIds = raw;
    } catch (e) {}
  }

  if (lockedIds === null) {
    // Genuine first sight: snapshot lock to both external and .company.
    const ad = ensureAnchorDir(anchorDir);
    if (ad && extLockPath) {
      try { fs.writeFileSync(extLockPath, currentIds.join('\n') + '\n'); } catch (e) {}
    }
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
      const extended = lockedIds.concat(added);
      // Write extensions to both external and .company.
      const ad = ensureAnchorDir(anchorDir);
      if (ad && extLockPath) {
        try { fs.writeFileSync(extLockPath, extended.join('\n') + '\n'); } catch (e) {}
      }
      try { fs.writeFileSync(lockPath, extended.join('\n') + '\n'); } catch (e) {}
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
