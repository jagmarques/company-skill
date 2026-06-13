#!/usr/bin/env node
// Assert package.json version matches the top ## heading in CHANGELOG.md.
// Prevents silent version/changelog drift.
// Zero deps - Node builtins only.
'use strict';
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();
const pkgPath = path.join(root, 'package.json');
const clPath = path.join(root, 'CHANGELOG.md');

if (!fs.existsSync(pkgPath)) {
  console.error('FAIL: package.json not found at ' + pkgPath);
  process.exit(1);
}
if (!fs.existsSync(clPath)) {
  console.error('FAIL: CHANGELOG.md not found at ' + clPath +
    ' - create it with a ## ' +
    JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version + ' heading');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const pkgVer = (pkg.version || '').trim();

const clText = fs.readFileSync(clPath, 'utf8');
const match = clText.match(/^## (.+)$/m);
if (!match) {
  console.error('FAIL: CHANGELOG.md has no ## <version> heading');
  process.exit(1);
}
const clVer = match[1].trim();

if (pkgVer !== clVer) {
  console.error(
    'FAIL: version mismatch - package.json=' + pkgVer +
    ' CHANGELOG.md=' + clVer
  );
  process.exit(1);
}

console.log('ok: version ' + pkgVer + ' matches CHANGELOG.md');
