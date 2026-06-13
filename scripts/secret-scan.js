#!/usr/bin/env node
// Pre-push secret scan for /company worker git discipline.
// Run before any `git push` or `gh pr create` in a worktree.
// Usage: node scripts/secret-scan.js [--worktree /path/to/wt]
//
// Degradation tiers (in order):
//   1. gitleaks git --no-banner --log-opts="origin/main.." . (branch-only, ~1s)
//   2. trufflehog git file://. --branch HEAD --results=verified --fail
//   3. High-signal grep fallback (sk_live_, pypi-, npm_, ghp_, AKIA, PEM headers)
//
// Exit codes: 0 = clean (or scanner absent with SCANNER-MISSING noted),
//             1 = secrets found (push must be blocked).
// Never hard-blocks when the scanner is absent: SCANNER-MISSING is noted
// in findings for the orchestrator to surface, but the push is not blocked.

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const wtIdx = args.indexOf('--worktree');
const worktree = wtIdx !== -1 ? args[wtIdx + 1] : process.cwd();

function run(cmd, cmdArgs, opts) {
  const r = spawnSync(cmd, cmdArgs, Object.assign({ encoding: 'utf8', cwd: worktree }, opts || {}));
  return r;
}

function hasCmd(cmd) {
  const r = spawnSync('command', ['-v', cmd], { encoding: 'utf8', shell: true });
  return r.status === 0;
}

// Tier 1: gitleaks
if (hasCmd('gitleaks')) {
  const r = run('gitleaks', ['git', '--no-banner', '--log-opts=origin/main..', '.']);
  if (r.status === 0) {
    console.log('SCANNER: gitleaks - clean');
    process.exit(0);
  } else if (r.status === 1) {
    console.error('BLOCKED-SECRET: gitleaks found potential secrets in branch commits');
    console.error(r.stdout || r.stderr || '');
    process.exit(1);
  }
  // gitleaks errored (e.g. no git repo) - fall through to next tier
}

// Tier 2: trufflehog (with --results=verified so only confirmed hits block)
if (hasCmd('trufflehog')) {
  const r = run('trufflehog', ['git', 'file://.', '--branch', 'HEAD', '--results=verified', '--fail']);
  if (r.status === 0) {
    console.log('SCANNER: trufflehog - clean');
    process.exit(0);
  } else if (r.status === 183) {
    console.error('BLOCKED-SECRET: trufflehog found verified secrets in branch commits');
    console.error(r.stdout || r.stderr || '');
    process.exit(1);
  }
  // trufflehog errored - fall through to grep tier
}

// Tier 3: high-signal grep fallback (patterns unlikely to false-positive on source code)
// This is not exhaustive - it is a last-resort signal that the branch added a likely secret.
const HIGH_SIGNAL = [
  '-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY',
  'sk_live_[A-Za-z0-9]{20,}',
  'pypi-AgEI[A-Za-z0-9+/]{20,}',
  'npm_[A-Za-z0-9]{36,}',
  'ghp_[A-Za-z0-9]{36,}',
  'AKIA[0-9A-Z]{16}',
  'xox[bp]-[A-Za-z0-9-]{24,}',
  // Coolify root tokens: numeric-id | 40+ alphanum (e.g. 8|u5nhEBunqJ4Q...)
  '\\d+\\|[A-Za-z0-9]{40,}',
  // Cloudflare API tokens (cfut_ prefix, 32+ alphanum)
  'cfut_[A-Za-z0-9]{32,}',
  // Hetzner Cloud API tokens have no stable prefix - omitted to avoid false-positives
  // against SHA256 hashes and base64 content. Use gitleaks for Hetzner coverage.
  // JWT bearer tokens (three dot-separated base64url segments, first segment eyJ)
  // Header segment can be short (e.g. 20 chars total), payload and sig must be longer.
  'eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}',
];

const grepPattern = HIGH_SIGNAL.join('|');
let diffOutput = '';
try {
  const r = spawnSync('git', ['diff', 'origin/main..HEAD'], { encoding: 'utf8', cwd: worktree });
  diffOutput = r.stdout || '';
} catch (e) {
  diffOutput = '';
}

if (diffOutput) {
  const re = new RegExp(grepPattern);
  if (re.test(diffOutput)) {
    console.error('BLOCKED-SECRET: high-signal pattern matched in branch diff (grep fallback)');
    console.error('Review the diff for: ' + HIGH_SIGNAL.join(', '));
    process.exit(1);
  }
  console.log('SCANNER: grep fallback - no high-signal patterns found');
  process.exit(0);
}

// No scanner available and no diff to grep - note the gap and do NOT block.
console.log('SCANNER-MISSING: gitleaks and trufflehog absent; could not scan branch diff. ' +
  'Install gitleaks (brew install gitleaks) for reliable pre-push secret scanning.');
process.exit(0);
