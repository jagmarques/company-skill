#!/usr/bin/env node
// Appends this session's company dashboard link to the Claude Code status line.
//
// Reads the statusline JSON from stdin (which carries session_id), looks up
// the per-session dashboard URL in .company/dashboard-registry.json, and
// appends "  |  📊 <url>" to the base statusline output.
//
// Chaining: the previously configured statusLine command is stored in
// .company/statusline-base.json (written by the SKILL.md setup step). This
// script runs that prior command first and passes its output through, so it
// is always NON-DESTRUCTIVE - it appends, never replaces.
//
// If no dashboard URL is found for the session, output is exactly the base
// statusline with nothing appended.
//
// Zero dependencies: Node built-ins only.

'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Read stdin once (the JSON the harness pipes in).
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch (_) {}

// Resolve the company state directory.
const dir = process.env.COMPANY_DIR || path.join(os.homedir(), '.company');

// --- Chaining: run the prior statusline command if one is stored ---
const baseCfgPath = path.join(dir, 'statusline-base.json');
let base = '';
try {
  const cfg = JSON.parse(fs.readFileSync(baseCfgPath, 'utf8'));
  // cfg.command is the prior command string (e.g. "node /path/to/gsd-statusline.js")
  if (cfg && cfg.command) {
    // Split on whitespace to get argv; treat first token as the executable.
    const parts = cfg.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    // Strip surrounding quotes from each part.
    const argv = parts.map(p => p.replace(/^['"]|['"]$/g, ''));
    if (argv.length > 0) {
      try {
        base = execFileSync(argv[0], argv.slice(1), {
          input,
          encoding: 'utf8',
          timeout: 4000,
        });
      } catch (_) {
        // Prior command failed - continue with empty base rather than crashing.
        base = '';
      }
    }
  }
} catch (_) {
  // No config or unreadable - no chaining, start fresh.
}

// --- Look up this session's dashboard URL ---
let url = null;
try {
  const sid = (JSON.parse(input).session_id) || '';
  if (sid) {
    const reg = JSON.parse(
      fs.readFileSync(path.join(dir, 'dashboard-registry.json'), 'utf8')
    );
    const entry = reg && reg.sessions && reg.sessions[sid];
    if (entry && entry.url) url = entry.url;
  }
} catch (_) {}

// Fall back to env override (e.g. COMPANY_DASHBOARD_PORT set manually).
if (!url && process.env.COMPANY_DASHBOARD_PORT) {
  url = 'http://127.0.0.1:' + process.env.COMPANY_DASHBOARD_PORT;
}

// --- Compose output ---
const link = url ? ('  |  \u{1F4CA} ' + url) : '';
// Strip trailing newline from base, then append link (with or without a newline).
const trimmed = base.replace(/\n+$/, '');
process.stdout.write(trimmed + link);
