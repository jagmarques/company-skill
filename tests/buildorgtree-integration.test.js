#!/usr/bin/env node
// Integration test: buildOrgTree must not throw and must return a valid tree.
//
// WHY THIS TEST EXISTS: the dead-enrichment removal deleted the activeCycle
// variable but left it in the buildOrgTree return object, causing a
// ReferenceError on every /api/state call (HTTP 500). The org-parser suite
// only exercised parseCompanyMd in isolation and never caught this.
//
// This test FAILS against the pre-fix code (ReferenceError in buildOrgTree)
// and PASSES after the fix (return object no longer references activeCycle).
//
// Strategy: spawn dashboard.js as a child process with a minimal fake
// COMPANY_DIR pointing at a controlled temp directory, then GET /api/state
// and assert the response is 200 with a valid org tree.

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DASHBOARD = path.join(__dirname, '..', 'scripts', 'dashboard.js');
// Use a port well outside the blocked set (7777/8765/8901) and the probed range
const TEST_PORT = 7490;

let failures = 0;
function fail(msg) {
  console.log('FAIL: ' + msg);
  failures++;
}
function ok(msg) {
  console.log('ok: ' + msg);
}

// Set up a minimal fake company dir so COMPANY.md parsing works.
const tmpDir = path.join(os.tmpdir(), 'orgtree-test-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'COMPANY.md'), [
  '## Engineering (Lead: CTO)',
  '- CTO, technical decisions',
  '- Backend Developer, API design',
  '## Quality (Lead: QA Lead)',
  '- QA Lead, test strategy',
  '- Security Reviewer, vulnerability analysis',
].join('\n'));
fs.writeFileSync(path.join(tmpDir, 'GOAL.md'), 'Build a great product.');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
}

// Spawn dashboard.js with a clean env so no CLAUDE_CODE_SESSION_ID leaks in.
const child = spawn(process.execPath, [DASHBOARD], {
  env: {
    HOME: os.tmpdir(),
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    COMPANY_DIR: tmpDir,
    COMPANY_DASHBOARD_PORT: String(TEST_PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOut = '';
child.stdout.on('data', (d) => { serverOut += d.toString(); });
child.stderr.on('data', (d) => { serverOut += d.toString(); });

// Wait for the server to print "listening" then probe /api/state.
const TIMEOUT_MS = 8000;
const deadline = setTimeout(() => {
  child.kill('SIGKILL');
  cleanup();
  fail('server did not start within ' + TIMEOUT_MS + 'ms (output: ' + serverOut + ')');
  process.exit(1);
}, TIMEOUT_MS);

function waitForServer(attempts) {
  if (serverOut.includes('listening')) {
    clearTimeout(deadline);
    probe();
    return;
  }
  if (attempts <= 0) {
    clearTimeout(deadline);
    child.kill('SIGKILL');
    cleanup();
    fail('server never printed "listening" (output: ' + serverOut + ')');
    process.exit(1);
    return;
  }
  setTimeout(() => waitForServer(attempts - 1), 200);
}
waitForServer(40);

function probe() {
  const req = http.get('http://127.0.0.1:' + TEST_PORT + '/api/state', (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      child.kill('SIGKILL');
      cleanup();

      // Must return 200 (not 500 from ReferenceError)
      if (res.statusCode !== 200) {
        fail('/api/state returned HTTP ' + res.statusCode + ' body: ' + body.slice(0, 200));
      } else {
        ok('/api/state returned HTTP 200');
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        fail('/api/state body is not valid JSON: ' + body.slice(0, 200));
        finish();
        return;
      }

      // Must not carry an "error" key (which indicates a caught throw)
      if (parsed.error) {
        fail('/api/state response has error key: ' + parsed.error);
      } else {
        ok('/api/state response has no error key');
      }

      // org must be a non-null object (buildOrgTree return value)
      const org = parsed.org;
      if (!org || typeof org !== 'object') {
        fail('response.org is missing or not an object');
      } else {
        ok('response.org is an object');
      }

      // org must have a nodes array with at least the orchestrator node
      const nodes = org && org.nodes;
      if (!Array.isArray(nodes) || nodes.length === 0) {
        fail('response.org.nodes is missing or empty');
      } else {
        ok('response.org.nodes has ' + nodes.length + ' entries');
      }

      // org must have a note string (proves the full return path executed)
      if (!org || typeof org.note !== 'string' || !org.note) {
        fail('response.org.note is missing or not a string');
      } else {
        ok('response.org.note present');
      }

      // activeCycle must NOT appear in the org object (the deleted variable)
      if ('activeCycle' in (org || {})) {
        fail('response.org still contains activeCycle (dangling key not removed)');
      } else {
        ok('response.org does not contain activeCycle');
      }

      finish();
    });
  });

  req.on('error', (e) => {
    child.kill('SIGKILL');
    cleanup();
    fail('/api/state request failed: ' + e.message);
    finish();
  });

  req.setTimeout(5000, () => {
    req.destroy();
    child.kill('SIGKILL');
    cleanup();
    fail('/api/state request timed out');
    finish();
  });
}

function finish() {
  if (failures === 0) {
    console.log('ALL BUILDORGTREE INTEGRATION TESTS PASSED');
    process.exit(0);
  } else {
    console.log(failures + ' BUILDORGTREE INTEGRATION TEST(S) FAILED');
    process.exit(1);
  }
}
