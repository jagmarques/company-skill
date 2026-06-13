#!/usr/bin/env node

// Tests for the grep fallback in scripts/secret-scan.js.
// Verifies that new token formats (Coolify, Cloudflare, JWT) are flagged,
// that the existing formats still work, and that clean content passes.
//
// Token values are constructed at runtime (not as static string literals) so
// that gitleaks does not flag this test file itself during pre-push scans.
// The patterns are extracted from the script source so the test stays in sync.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'secret-scan.js');

let failures = 0;
let caseNo = 0;

function check(name, expected, got) {
  caseNo += 1;
  if (got === expected) {
    console.log('ok: case ' + caseNo + ' ' + name);
  } else {
    console.log('FAIL case ' + caseNo + ' (' + name + '): expected ' + expected + ', got ' + got);
    failures += 1;
  }
}

// Extract HIGH_SIGNAL from the script source by evaluating just that array.
// This keeps the test in sync with the script without duplicating the patterns.
const scriptSrc = fs.readFileSync(SCRIPT, 'utf8');
const match = scriptSrc.match(/const HIGH_SIGNAL = \[([\s\S]*?)\];/);
if (!match) {
  console.log('FAIL: could not extract HIGH_SIGNAL from secret-scan.js');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const HIGH_SIGNAL = new Function('return [' + match[1] + ']')();
const grepPattern = HIGH_SIGNAL.join('|');
const re = new RegExp(grepPattern);

// Helper: does the pattern flag this line?
function flags(line) { return re.test(line); }

// Build fake tokens at runtime to avoid static literal matching by scanners.
// Each token is structurally valid for the pattern but is not a real credential.
function repeat(s, n) { return Array(n + 1).join(s); }

const fakeNpm = 'npm_' + repeat('A', 36);
const fakeGhp = 'ghp_' + repeat('B', 36);
// pypi-AgEI prefix + 20+ base64 chars (no dash after AgEI - it is part of the token body)
const fakePypi = 'pypi-AgEI' + repeat('C', 30);
const fakeSkLive = 'sk_live_' + repeat('D', 25);
const fakeCoolify = '8|' + repeat('E', 42);
const fakeCfut = 'cfut_' + repeat('F', 33);
// JWT: three base64url segments, all runtime-built
const jwtHdr = 'eyJhbGciOiJSUzI1NiJ9'; // {"alg":"RS256"} - safe static (short, not a secret)
const jwtPayload = 'eyJ' + repeat('G', 50) + '9'; // runtime-built payload segment
const jwtSig = repeat('H', 43); // runtime-built signature segment
const fakeJwt = jwtHdr + '.' + jwtPayload + '.' + jwtSig;
const fakeSlack = 'xoxb-' + repeat('1', 12) + '-' + repeat('2', 12) + '-' + repeat('A', 24);

// --- Existing formats: confirm they still work ---

check('PEM private key still flagged',
  true, flags('-----BEGIN RSA PRIVATE KEY-----'));

check('sk_live_ token still flagged',
  true, flags('+SECRET=' + fakeSkLive));

check('pypi token still flagged',
  true, flags('+token = ' + fakePypi));

check('npm token still flagged',
  true, flags('+NPM_TOKEN=' + fakeNpm));

check('ghp token still flagged',
  true, flags('+GH_TOKEN=' + fakeGhp));

check('AWS AKIA token still flagged',
  true, flags('+AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'));

check('Slack xoxb token still flagged',
  true, flags('+SLACK_TOKEN=' + fakeSlack));

// --- New formats: M1 fix ---

// Coolify root token shape: <digits>|<40+ alphanum>
check('Coolify token flagged',
  true, flags('+COOLIFY_TOKEN=' + fakeCoolify));

check('Coolify token flagged (longer id)',
  true, flags('+token = 123|' + repeat('K', 40)));

// Cloudflare API token: cfut_ + 32+ alphanum
check('Cloudflare cfut_ token flagged',
  true, flags('+CF_TOKEN=' + fakeCfut));

check('Cloudflare cfut_ exactly 32 chars flagged',
  true, flags('+CF_TOKEN=cfut_' + repeat('Z', 32)));

// JWT bearer token: three dot-separated base64url segments, first starts eyJ
check('JWT bearer token flagged',
  true, flags('+TOKEN=' + fakeJwt));

check('JWT with short header flagged',
  true, flags('+AUTH=' + jwtHdr + '.' + repeat('P', 72) + '.' + repeat('Q', 52)));

// --- Clean content: must NOT be flagged ---

check('plain variable assignment not flagged',
  false, flags('+const foo = "hello world";'));

check('normal base64 not flagged (no eyJ prefix)',
  false, flags('+const encoded = "SGVsbG8gV29ybGQ=";'));

check('hex sha256 not flagged',
  false, flags('+sha = "' + repeat('a', 64) + '";'));

check('short pipe-separated id not flagged (< 40 chars after pipe)',
  false, flags('+id = "1|shortvalue";'));

check('cfut_ too short not flagged (< 32 chars)',
  false, flags('+CF_TOKEN=cfut_' + repeat('X', 31)));

check('jwt two segments not flagged (no third segment)',
  false, flags('+partial = "' + jwtHdr + '.' + repeat('R', 40) + '";'));

check('short eyJ comment not flagged',
  false, flags('// eyJhbGci is the start of a JWT header'));

// --- Run the script against a clean temp dir to confirm exit 0 ---
// (No gitleaks/trufflehog; no diff from origin/main = SCANNER-MISSING or clean, exit 0.)
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-test-'));
  spawnSync('git', ['init'], { cwd: tmp });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmp });
  const r = spawnSync(process.execPath, [SCRIPT, '--worktree', tmp], { encoding: 'utf8' });
  caseNo += 1;
  if (r.status === 0) {
    console.log('ok: case ' + caseNo + ' clean repo exits 0 (grep fallback or SCANNER-MISSING)');
  } else {
    console.log('FAIL case ' + caseNo + ' (clean repo exits 0): got exit ' + r.status);
    console.log(r.stdout, r.stderr);
    failures += 1;
  }
}

if (failures > 0) {
  console.log('SECRET-SCAN TESTS FAILED: ' + failures);
  process.exit(1);
}
console.log('ALL SECRET-SCAN TESTS PASSED (' + caseNo + ' checks)');
