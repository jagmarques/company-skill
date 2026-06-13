#!/usr/bin/env node
// Gate for documented script commands: every referenced scripts/<name>.js
// must exist, and user-facing sections must not use bare relative paths.
//
// Two assertions:
//   A1 (all files): every "scripts/<name>.js" reference AND every
//      "<skill-scripts-dir>/<name>.js" / "~/.claude/skills/company/scripts/<name>.js"
//      reference names a file that actually exists in scripts/.
//      Catches renamed/removed/typo'd scripts in BOTH reference forms.
//   A2 (SKILL.md + agents/ only): user-facing command examples must not use
//      bare "node scripts/<x>.js" that assumes cwd is the repo clone. The
//      accepted form is the <skill-scripts-dir>/<x>.js placeholder (matching
//      the secret-scan precedent in worker docs) or an absolute/installed path.
//      Each "node scripts/x.js" occurrence is checked independently - the
//      presence of a placeholder sibling in the same snippet does NOT excuse
//      a bare path in the same span.
//      Bare "node scripts/x.js" is allowed ONLY inside sections whose heading
//      contains "Contributing" or "development", or the check.sh self-reference.
//
// README.md is scanned for A1 only (existence). Its Dashboard section bare
// path is handled by a separate PR and is deliberately excluded from A2.
//
// Exit 0 with "ok" lines when all assertions pass.
// Exit 1 with "FAIL" lines naming file:line:command for each violation.
//
// Usage: node scripts/check-doc-commands.js
// Run from repo root or any directory: paths are resolved relative to this script.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// Files to scan
const SCAN_A1 = [
  path.join(ROOT, 'skill', 'SKILL.md'),
  path.join(ROOT, 'README.md'),
];
const AGENTS_DIR = path.join(ROOT, 'agents');
const agentFiles = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => path.join(AGENTS_DIR, f));

const ALL_FILES = SCAN_A1.concat(agentFiles);
// A2 check is only on SKILL.md and agents/ (not README.md)
const A2_FILES = [path.join(ROOT, 'skill', 'SKILL.md')].concat(agentFiles);

// Match "scripts/<name>.js" anywhere in text (captures the name)
const SCRIPT_REF_RE = /\bscripts\/([A-Za-z0-9_-]+\.js)\b/g;
// Match "<skill-scripts-dir>/<name>.js" placeholder form
const PLACEHOLDER_REF_RE = /<skill-scripts-dir>\/([A-Za-z0-9_-]+\.js)\b/g;
// Match installed path form "~/.claude/skills/company/scripts/<name>.js"
const INSTALLED_REF_RE = /~\/.claude\/skills\/company\/scripts\/([A-Za-z0-9_-]+\.js)\b/g;

// Headings that mark a repo-clone / dev context where bare paths are fine.
// The check allows bare paths in any block after such a heading (until next
// same-or-higher-level heading or end of file).
const DEV_HEADING_RE = /^#{1,4}\s.*(contributing|development)/i;

let fail = 0;

function check(ok, msg) {
  if (ok) {
    console.log('ok: ' + msg);
  } else {
    console.error('FAIL: ' + msg);
    fail = 1;
  }
}

// --- A1: every referenced script file must exist ---
// Checks bare scripts/<name>.js, <skill-scripts-dir>/<name>.js, and installed forms.
const missing = new Set();

function checkScriptExists(name, lineNo, rel) {
  const full = path.join(SCRIPTS_DIR, name);
  if (!fs.existsSync(full)) {
    missing.add(name);
    check(false, rel + ':' + lineNo + ' references missing script scripts/' + name);
  }
}

for (const file of ALL_FILES) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  // Check bare "scripts/<name>.js" references
  SCRIPT_REF_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_REF_RE.exec(text)) !== null) {
    const name = m[1];
    const before = text.slice(0, m.index);
    const lineNo = before.split('\n').length;
    checkScriptExists(name, lineNo, rel);
  }

  // Check "<skill-scripts-dir>/<name>.js" placeholder references
  PLACEHOLDER_REF_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_REF_RE.exec(text)) !== null) {
    const name = m[1];
    const before = text.slice(0, m.index);
    const lineNo = before.split('\n').length;
    checkScriptExists(name, lineNo, rel);
  }

  // Check installed path "~/.claude/skills/company/scripts/<name>.js" references
  INSTALLED_REF_RE.lastIndex = 0;
  while ((m = INSTALLED_REF_RE.exec(text)) !== null) {
    const name = m[1];
    const before = text.slice(0, m.index);
    const lineNo = before.split('\n').length;
    checkScriptExists(name, lineNo, rel);
  }
}
if (missing.size === 0) {
  check(true, 'A1 - all referenced scripts exist');
}

// --- A2: no bare "node scripts/x.js" in user-facing sections ---
// (SKILL.md and agents/ only; README.md is deferred to a separate PR)
// Each "node scripts/x.js" token is evaluated independently.
// A placeholder elsewhere in the same snippet does NOT excuse a bare occurrence.
for (const file of A2_FILES) {
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inDevSection = false;
  let a2Violations = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track dev/contributing section headings
    if (/^#{1,4}\s/.test(line)) {
      inDevSection = DEV_HEADING_RE.test(line);
    }
    if (inDevSection) continue;

    // Find every backtick span on this line and check each "node scripts/x.js"
    // occurrence within it independently.
    const spanRe = /`([^`]+)`/g;
    let spanMatch;
    while ((spanMatch = spanRe.exec(line)) !== null) {
      const span = spanMatch[1];
      // Find each "node scripts/<name>.js" occurrence in this span
      const nodeRe = /\bnode\s+scripts\/([A-Za-z0-9_-]+\.js)\b/g;
      let nodeMatch;
      while ((nodeMatch = nodeRe.exec(span)) !== null) {
        const rel = path.relative(ROOT, file);
        check(false,
          rel + ':' + (i + 1) + ' bare "node scripts/' + nodeMatch[1] +
          '" in user-facing section (use <skill-scripts-dir>/' + nodeMatch[1] + ')');
        a2Violations += 1;
      }
    }
  }
  if (a2Violations === 0) {
    const rel = path.relative(ROOT, file);
    check(true, 'A2 - no bare node scripts/ in user-facing sections: ' + rel);
  }
}

if (fail) {
  console.error('DOC-COMMANDS: checks failed');
  process.exit(1);
}
console.log('DOC-COMMANDS: all checks passed');
process.exit(0);
