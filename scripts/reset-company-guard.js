#!/usr/bin/env node

// Deliberate reset for the company stop-guard anchor.
//
// PURPOSE: when you are intentionally starting a new /company run for a new goal,
// this script clears the stale anchor left by the previous run so the stop-guard
// can snapshot the new id-set on first sight. Run it only when intentionally
// starting fresh - it removes the tamper-protection state for this COMPANY_DIR.
//
// DO NOT rely on this script running automatically or being triggered by any
// file-state heuristic. It is an explicit, auditable action run by a human or
// the orchestrator at parse time (before writing new criteria.json). The stop-guard
// itself has NO self-heal: any automatic heal keyed on .company/ file state
// (mtime, content hash, GOAL text) is bypassable by the same in-run actor that
// writes criteria.json, so there is none by design.
//
// WHAT IT CLEARS:
//   ~/.claude/company-guard-state/<key>/   - entire external anchor dir
//   .company/criteria.lock                 - local lock snapshot
//   where key = sha256(realpath(COMPANY_DIR)).slice(0,16)
//
// USAGE: node <skill-scripts-dir>/reset-company-guard.js
//   COMPANY_DIR defaults to ./.company (same as stop-guard).
//   Override: COMPANY_DIR=/path/to/.company node reset-company-guard.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const companyDir = process.env.COMPANY_DIR || path.join(process.cwd(), '.company');
const lockPath = path.join(companyDir, 'criteria.lock');

let anchorDir = null;
let anchorKey = null;
try {
  const real = fs.realpathSync(companyDir);
  anchorKey = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
  const home = process.env.HOME || '';
  anchorDir = path.join(home, '.claude', 'company-guard-state', anchorKey);
} catch (e) {
  console.error('reset-company-guard: could not resolve COMPANY_DIR: ' + companyDir);
  process.exit(1);
}

let cleared = [];

// Remove external anchor dir.
if (fs.existsSync(anchorDir)) {
  try {
    fs.rmSync(anchorDir, { recursive: true, force: true });
    cleared.push('external anchor dir: ' + anchorDir);
  } catch (e) {
    console.error('reset-company-guard: failed to remove ' + anchorDir + ': ' + e.message);
    process.exit(1);
  }
} else {
  console.log('reset-company-guard: no external anchor dir at ' + anchorDir + ' (already clean)');
}

// Remove local criteria.lock.
if (fs.existsSync(lockPath)) {
  try {
    fs.unlinkSync(lockPath);
    cleared.push('criteria.lock: ' + lockPath);
  } catch (e) {
    console.error('reset-company-guard: failed to remove ' + lockPath + ': ' + e.message);
    process.exit(1);
  }
} else {
  console.log('reset-company-guard: no criteria.lock at ' + lockPath + ' (already clean)');
}

if (cleared.length > 0) {
  console.log('reset-company-guard: cleared for COMPANY_DIR=' + companyDir + ' (key=' + anchorKey + ')');
  cleared.forEach(function (item) { console.log('  removed ' + item); });
}
console.log('reset-company-guard: done. Stop-guard will snapshot a fresh id-set on next run.');
