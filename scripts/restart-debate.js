#!/usr/bin/env node

// Records that the 3-role restart debate ran with non-empty role outputs.
// It cannot verify the debate was GOOD, only that 3 role verdicts were supplied.
// Usage: echo '{"sourceVerifier":"...","devilsAdvocate":"...","completenessCritic":"..."}' | node scripts/restart-debate.js

const fs = require('fs');
const path = require('path');

// Parse --session arg if provided, fallback to env CLAUDE_CODE_SESSION_ID.
let sessionArg = null;
const argIdx = process.argv.indexOf('--session');
if (argIdx !== -1 && process.argv[argIdx + 1]) {
  sessionArg = process.argv[argIdx + 1];
}
const sessionId = sessionArg || process.env.CLAUDE_CODE_SESSION_ID || null;

const companyDir = process.env.COMPANY_DIR || path.join(process.cwd(), '.company');

let input;
try {
  const raw = fs.readFileSync(0, 'utf8');
  input = JSON.parse(raw);
} catch (e) {
  process.stderr.write('Error: could not parse JSON from stdin: ' + e.message + '\n');
  process.exit(1);
}

if (!input || typeof input !== 'object') {
  process.stderr.write('Error: stdin must be a JSON object\n');
  process.exit(1);
}

// Validate all 3 required role verdicts are present and non-empty.
const REQUIRED = ['sourceVerifier', 'devilsAdvocate', 'completenessCritic'];
let valid = true;
for (const field of REQUIRED) {
  const val = input[field];
  if (typeof val !== 'string' || val.trim() === '') {
    process.stderr.write('Error: field "' + field + '" is required and must be a non-empty string\n');
    valid = false;
  }
}
if (!valid) {
  process.exit(1);
}

// Build the artifact record.
const record = {
  sourceVerifier: input.sourceVerifier.trim(),
  devilsAdvocate: input.devilsAdvocate.trim(),
  completenessCritic: input.completenessCritic.trim(),
  claimsVerified: typeof input.claimsVerified === 'string' ? input.claimsVerified.trim() : undefined,
  sessionId: sessionId,
  recordedAtTokensMarker: Date.now(),
};
if (record.claimsVerified === undefined) delete record.claimsVerified;

try {
  fs.mkdirSync(companyDir, { recursive: true });
} catch (e) {
  process.stderr.write('Error: could not create company dir: ' + e.message + '\n');
  process.exit(1);
}

const artifactPath = path.join(companyDir, 'RESTART_DEBATE_CONFIRMED');
try {
  fs.writeFileSync(artifactPath, JSON.stringify(record, null, 2));
} catch (e) {
  process.stderr.write('Error: could not write artifact: ' + e.message + '\n');
  process.exit(1);
}

console.log(artifactPath);
process.exit(0);
