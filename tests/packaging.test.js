#!/usr/bin/env node
// Packaging smoke test: every runtime script referenced in SKILL.md and
// agents/*.md must appear in BOTH installer lists. Catches the class of
// bug where a new script is referenced in the skill but never added to
// bin/install.js or install.sh, so it silently fails to install.
//
// The referenced-set is built dynamically from the source files so a new
// reference automatically demands an installer update without editing this
// test.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
let n = 0;

function check(name, fn) {
  n += 1;
  const err = fn();
  if (err) {
    console.log('FAIL case ' + n + ' (' + name + '): ' + err);
    failures += 1;
  } else {
    console.log('ok: case ' + n + ' ' + name);
  }
}

// Collect all .js basenames that exist in scripts/ (runtime candidates).
const scriptsDir = path.join(ROOT, 'scripts');
const allScripts = new Set(
  fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js'))
);

// Build referenced-set: grep SKILL.md and agents/*.md for any scripts/<name>.js
// pattern OR any bare <name>.js that is a known script filename.
// Two distinct patterns appear in the source:
//   - "scripts/foo.js" (direct path reference)
//   - "<skill-scripts-dir>/foo.js" or bare "foo.js" mention where foo.js lives
//     in scripts/
// We capture both by: (a) extracting all explicit "scripts/<name>.js" matches,
// and (b) matching any word-boundary "<name>.js" occurrence where that name
// exists in scripts/.
const sourceFiles = [
  path.join(ROOT, 'skill', 'SKILL.md'),
  ...fs.readdirSync(path.join(ROOT, 'agents'))
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(ROOT, 'agents', f)),
];

const referenced = new Set();
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8');
  // Pattern 1: explicit "scripts/<name>.js"
  const explicit = text.match(/scripts\/([a-zA-Z0-9_-]+\.js)/g) || [];
  for (const m of explicit) {
    referenced.add(m.replace('scripts/', ''));
  }
  // Pattern 2: any bare "<name>.js" that is a known script file
  const bare = text.match(/\b([a-zA-Z0-9_-]+\.js)\b/g) || [];
  for (const m of bare) {
    if (allScripts.has(m)) referenced.add(m);
  }
}

// Exclude repo-only files: check.sh is not a .js file so irrelevant here.
// tests/ files are intentionally not installed (per install.sh comment).
// Both installer lists already exclude them; we match that intent by only
// checking scripts that exist in scripts/ (not tests/).
// No further exclusion needed since allScripts only lists scripts/*.js.

// Parse INSTALL_SCRIPTS from bin/install.js.
function parseInstallJs() {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf8');
  // Match the array literal assigned to INSTALL_SCRIPTS.
  const m = src.match(/const INSTALL_SCRIPTS\s*=\s*\[([^\]]+)\]/s);
  if (!m) throw new Error('Could not locate INSTALL_SCRIPTS array in bin/install.js');
  const items = m[1].match(/'([^']+\.js)'/g) || [];
  return new Set(items.map(s => s.replace(/'/g, '')));
}

// Parse the "for script in ..." list from install.sh.
function parseInstallSh() {
  const src = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  // Match the line: for script in codegraph.js check-contracts.js ...
  const m = src.match(/for script in ([^\n;]+)/);
  if (!m) throw new Error('Could not locate "for script in ..." line in install.sh');
  const names = m[1].trim().split(/\s+/).filter(s => s.endsWith('.js'));
  return new Set(names);
}

let installJsSet, installShSet;
try {
  installJsSet = parseInstallJs();
} catch (e) {
  console.log('FAIL: could not parse bin/install.js INSTALL_SCRIPTS: ' + e.message);
  process.exit(1);
}
try {
  installShSet = parseInstallSh();
} catch (e) {
  console.log('FAIL: could not parse install.sh script list: ' + e.message);
  process.exit(1);
}

// Case 1: every referenced script is in bin/install.js.
check('all referenced scripts present in bin/install.js', function () {
  const missing = [];
  for (const s of referenced) {
    if (!installJsSet.has(s)) missing.push(s);
  }
  if (missing.length > 0) {
    return 'script(s) referenced in skill/agents but missing from bin/install.js: '
      + missing.join(', ');
  }
});

// Case 2: every referenced script is in install.sh.
check('all referenced scripts present in install.sh', function () {
  const missing = [];
  for (const s of referenced) {
    if (!installShSet.has(s)) missing.push(s);
  }
  if (missing.length > 0) {
    return 'script(s) referenced in skill/agents but missing from install.sh: '
      + missing.join(', ');
  }
});

// Case 3: both installer lists are identical sets.
check('bin/install.js and install.sh installer lists are identical', function () {
  const onlyInJs = [...installJsSet].filter(s => !installShSet.has(s));
  const onlyInSh = [...installShSet].filter(s => !installJsSet.has(s));
  if (onlyInJs.length > 0 || onlyInSh.length > 0) {
    const parts = [];
    if (onlyInJs.length) parts.push('only in bin/install.js: ' + onlyInJs.join(', '));
    if (onlyInSh.length) parts.push('only in install.sh: ' + onlyInSh.join(', '));
    return 'installer lists diverged: ' + parts.join('; ');
  }
});

if (failures > 0) {
  console.log('PACKAGING TESTS FAILED: ' + failures);
  process.exit(1);
}
console.log('ALL PACKAGING TESTS PASSED (' + n + ' checks, referenced: '
  + [...referenced].sort().join(', ') + ')');
