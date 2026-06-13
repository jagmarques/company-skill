#!/usr/bin/env node
// company-autoloop.js - External supervisor for /company auto-restart cycles.
//
// WHY THIS IS A SEPARATE SCRIPT (not native hooks):
//   A fully unattended detect->restart->fresh-context loop is IMPOSSIBLE with
//   Claude Code native features alone. Stop-hook decision:block keeps the SAME
//   context (does not reset). /clear is interactive-only. Auto-compaction
//   summarizes in-session, never resets. The SessionStart hook's
//   initialUserMessage only works in non-interactive (-p) mode.
//   Conclusion: fresh context requires a NEW process invocation - i.e. this
//   external script. See .company/eng/auto-restart-research.md.
//
// HOW IT WORKS:
//   Each cycle launches a BRAND-NEW `claude -p` session (fresh --session-id,
//   NO --continue/--resume). The existing context-guard Stop hook fires at the
//   threshold, blocks until the restart debate completes, writes NEXT.md +
//   RESTART_DEBATE_CONFIRMED, then allows the stop. This supervisor reads those
//   artifacts and launches the next cycle seeded with NEXT.md. It never touches
//   the debate mechanics itself - those are already automated by context-guard.js.
//
// USAGE:
//   node scripts/company-autoloop.js [options] "<goal>"
//   node scripts/company-autoloop.js [options] --prompt-file /path/to/goal.txt
//
// OPTIONS:
//   --project-dir <path>   Project dir the /company run targets (default: cwd)
//   --company-dir <path>   Override .company dir (default: <project-dir>/.company)
//   --max-cycles <n>       Hard cap on restart cycles (default: 50)
//   --permission-mode <m>  claude --permission-mode value (default: bypassPermissions)
//   --prompt-file <path>   Read initial goal from file instead of CLI arg
//   --help                 Show this message
//
// ENV:
//   CLAUDE_BIN             Path to the claude binary (default: claude)
//   COMPANY_DIR            Overrides --company-dir
//   COMPANY_CONTEXT_THRESHOLD  Forwarded to the spawned session unchanged

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

// ---------- arg parsing ----------
const argv = process.argv.slice(2);

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function hasFlag(flag) {
  return argv.indexOf(flag) !== -1;
}

if (hasFlag('--help') || hasFlag('-h')) {
  process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(l => l.startsWith('//'))
    .map(l => l.slice(3))
    .join('\n') + '\n');
  process.exit(0);
}

const projectDir = path.resolve(argValue('--project-dir') || process.cwd());
const companyDirArg = argValue('--company-dir');
// COMPANY_DIR env wins, then --company-dir, then <projectDir>/.company
const companyDir = path.resolve(
  process.env.COMPANY_DIR || companyDirArg || path.join(projectDir, '.company')
);

const maxCycles = parseInt(argValue('--max-cycles') || '50', 10);
const permissionMode = argValue('--permission-mode') || 'bypassPermissions';
const promptFile = argValue('--prompt-file');
const claudeBin = process.env.CLAUDE_BIN || 'claude';

// Positional goal: last non-flag arg that is not a flag value
let goalArg = null;
const flagsWithValues = new Set([
  '--project-dir', '--company-dir', '--max-cycles',
  '--permission-mode', '--prompt-file',
]);
for (let i = 0; i < argv.length; i++) {
  if (flagsWithValues.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith('--')) continue;
  goalArg = argv[i];
}

function readInitialPrompt() {
  if (promptFile) {
    try {
      return fs.readFileSync(promptFile, 'utf8').trim();
    } catch (e) {
      die('Cannot read --prompt-file ' + promptFile + ': ' + e.message);
    }
  }
  if (goalArg) return goalArg.trim();
  die('No goal provided. Pass a goal string or --prompt-file <path>.');
}

// ---------- helpers ----------
function log(msg) {
  const ts = new Date().toISOString();
  process.stderr.write('[autoloop ' + ts + '] ' + msg + '\n');
}

function die(msg) {
  process.stderr.write('ERROR: ' + msg + '\n');
  process.exit(1);
}

// ---------- state file paths ----------
const nextMdPath = path.join(companyDir, 'NEXT.md');
const cancelPath = path.join(companyDir, 'CANCEL');
const criteriaPath = path.join(companyDir, 'criteria.json');
const debateConfirmedPath = path.join(companyDir, 'RESTART_DEBATE_CONFIRMED');

// ---------- goal-done check ----------
// Real criteria.json is an object {goal, criteria:[{passes:bool,...}]}.
// Accept both shapes: parsed.criteria array, or a bare top-level array.
// An entry is done when passes === true (primary) or status done/pass (legacy).
// Empty/missing criteria, or a parse error: not done.
function isGoalDone() {
  try {
    const raw = fs.readFileSync(criteriaPath, 'utf8');
    const parsed = JSON.parse(raw);
    let list;
    if (parsed && Array.isArray(parsed.criteria)) {
      list = parsed.criteria;
    } else if (Array.isArray(parsed)) {
      list = parsed;
    } else {
      return false;
    }
    if (list.length === 0) return false;
    return list.every(function (c) {
      if (c && c.passes === true) return true;
      const s = (c && c.status ? String(c.status) : '').toLowerCase();
      return s === 'done' || s === 'pass';
    });
  } catch (e) {
    return false;
  }
}

// ---------- restart-happened check ----------
// RESTART_DEBATE_CONFIRMED must exist, and NEXT.md mtime must be after loopStart.
function isRestartReady(loopStartMs) {
  try {
    if (!fs.existsSync(debateConfirmedPath)) return false;
    const nextStat = fs.statSync(nextMdPath);
    return nextStat.mtimeMs > loopStartMs;
  } catch (e) {
    return false;
  }
}

// ---------- main loop ----------
function main() {
  let currentPrompt = readInitialPrompt();

  log('supervisor start | project=' + projectDir + ' company=' + companyDir +
      ' max-cycles=' + maxCycles + ' permission-mode=' + permissionMode);
  log('initial prompt length=' + currentPrompt.length + ' chars');

  let errorStreak = 0;
  const MAX_ERROR_STREAK = 3;

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const sessionId = randomUUID();
    const loopStart = Date.now();

    log('cycle ' + cycle + '/' + maxCycles + ' | session-id=' + sessionId);

    // Clean up stale RESTART_DEBATE_CONFIRMED from a previous cycle so it does
    // not confuse our restart-ready check after a restart that wrote nothing new.
    try { fs.unlinkSync(debateConfirmedPath); } catch (e) {}

    const spawnArgs = [
      '-p',
      '--session-id', sessionId,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-hook-events',
      '--permission-mode', permissionMode,
      currentPrompt,
    ];

    const spawnEnv = Object.assign({}, process.env, {
      COMPANY_DIR: companyDir,
    });

    log('spawning: ' + claudeBin + ' -p --session-id ' + sessionId + ' ...');

    const result = spawnSync(claudeBin, spawnArgs, {
      env: spawnEnv,
      cwd: projectDir,
      encoding: 'utf8',
      // No timeout: the session runs until context-guard fires or goal completes.
      // maxBuffer: large to capture full stream-json output.
      maxBuffer: 100 * 1024 * 1024,
    });

    const exitCode = result.status;
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    log('cycle ' + cycle + ' exited code=' + exitCode +
        ' stdout-bytes=' + stdout.length + ' stderr-bytes=' + stderr.length);

    // Classify result. Order matters: CANCEL beats everything.
    if (fs.existsSync(cancelPath)) {
      log('CANCEL file present - stopping supervisor');
      process.exit(0);
    }

    if (isGoalDone()) {
      log('goal DONE (all criteria pass) - exiting 0');
      process.exit(0);
    }

    if (isRestartReady(loopStart)) {
      let nextPrompt;
      try {
        nextPrompt = fs.readFileSync(nextMdPath, 'utf8').trim();
      } catch (e) {
        log('WARN: could not read NEXT.md: ' + e.message + ' - falling back to original prompt');
        nextPrompt = currentPrompt;
      }
      if (!nextPrompt) {
        log('WARN: NEXT.md is empty - falling back to original prompt');
        nextPrompt = currentPrompt;
      }
      log('restart detected - next prompt from NEXT.md (' + nextPrompt.length + ' chars)');
      currentPrompt = nextPrompt;
      errorStreak = 0;
      continue;
    }

    // Neither done nor restart: count as an error.
    errorStreak += 1;
    const reason = exitCode !== 0
      ? 'claude exited ' + exitCode
      : 'session ended without goal completion or restart state';

    if (stderr) log('stderr excerpt: ' + stderr.slice(0, 500));

    log('WARN cycle ' + cycle + ' - ' + reason +
        ' (error streak ' + errorStreak + '/' + MAX_ERROR_STREAK + ')');

    if (errorStreak >= MAX_ERROR_STREAK) {
      process.stderr.write(
        'ERROR: ' + MAX_ERROR_STREAK + ' consecutive non-restart non-done cycles.\n' +
        'Last exit code: ' + exitCode + '\n' +
        'Check: ' + companyDir + '/NEXT.md + criteria.json + CANCEL\n'
      );
      process.exit(2);
    }

    // Retry on transient error - same prompt.
    log('retrying (same prompt) ...');
  }

  process.stderr.write(
    'ERROR: max-cycles (' + maxCycles + ') reached without goal completion.\n' +
    'Increase --max-cycles or verify criteria.json.\n'
  );
  process.exit(3);
}

main();
