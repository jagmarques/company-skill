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
// HOW IT WORKS (monitor-and-kill, mimics a human running /clear):
//   Each cycle launches a BRAND-NEW `claude -p` session (fresh --session-id,
//   NO --continue/--resume), spawned ASYNC and detached in its own process group.
//   A real mid-goal restart CANNOT exit cleanly: the stop-guard blocks any stop
//   while criteria are unmet and the context-guard only forces a restart prompt.
//   In the manual flow the human does not wait for a clean stop - they run /clear
//   to ABANDON the stuck session once the restart prompt is emitted. So this
//   supervisor POLLS the .company markers WHILE the child runs and KILLS the whole
//   child process group the moment it sees done/restart/cancel, then relaunches
//   fresh. Waiting for natural exit hangs forever on a real mid-goal restart.
//   The context-guard Stop hook still drives the debate and writes NEXT.md +
//   RESTART_DEBATE_CONFIRMED. This supervisor never touches the debate mechanics.
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
//   --cycle-timeout-secs <n>  Per-cycle wall-clock cap before kill (default: 1800)
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
const { spawn } = require('node:child_process');

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
const cycleTimeoutSecs = parseInt(argValue('--cycle-timeout-secs') || '1800', 10);
const claudeBin = process.env.CLAUDE_BIN || 'claude';

// Positional goal: last non-flag arg that is not a flag value
let goalArg = null;
const flagsWithValues = new Set([
  '--project-dir', '--company-dir', '--max-cycles',
  '--permission-mode', '--prompt-file', '--cycle-timeout-secs',
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

// ---------- async sleep ----------
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ---------- kill the child process group ----------
// child.pid is the leader of its own group (spawn detached). Signal -pid to hit
// the WHOLE tree (headless claude spawns its own sub-agents). SIGTERM, grace,
// then SIGKILL. Guard pid<=1 so we never signal an invalid or init group.
async function killChildGroup(child) {
  const pid = child && child.pid;
  if (!pid || pid <= 1) return;
  function signalGroup(sig) {
    try { process.kill(-pid, sig); } catch (e) {}
  }
  signalGroup('SIGTERM');
  // Wait up to ~5s for the group to die, polling exit.
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
  signalGroup('SIGKILL');
  // Give the kernel a moment to reap.
  await sleep(200);
}

// ---------- spawn one detached child for a cycle ----------
// Returns the ChildProcess. stdout/stderr are drained into buffers so a full
// pipe never blocks the child. Detached + own group so the whole tree is killable.
function spawnChild(sessionId, prompt) {
  const spawnArgs = [
    '-p',
    '--session-id', sessionId,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--permission-mode', permissionMode,
    prompt,
  ];

  const spawnEnv = Object.assign({}, process.env, {
    COMPANY_DIR: companyDir,
  });

  log('spawning: ' + claudeBin + ' -p --session-id ' + sessionId + ' ...');

  const child = spawn(claudeBin, spawnArgs, {
    cwd: projectDir,
    env: spawnEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child._stdoutBytes = 0;
  child._stderrTail = '';
  child.stdout.on('data', function (d) { child._stdoutBytes += d.length; });
  child.stderr.on('data', function (d) {
    // Keep only a bounded tail so the buffer never grows without limit.
    child._stderrTail = (child._stderrTail + d.toString()).slice(-2000);
  });
  // Never let an EPIPE on the pipes crash the supervisor.
  child.stdout.on('error', function () {});
  child.stderr.on('error', function () {});

  return child;
}

// ---------- per-cycle outcome ----------
// Spawn the child, then poll the .company markers every ~3s WHILE it runs.
// Returns one of: { kind: 'cancel' } | { kind: 'done' }
//   | { kind: 'restart', prompt } | { kind: 'timeout' } | { kind: 'error', exitCode }
async function runCycle(sessionId, prompt, loopStart) {
  const child = spawnChild(sessionId, prompt);

  let exited = false;
  let exitCode = null;
  child.on('exit', function (code) { exited = true; exitCode = code; });
  // Surface a spawn failure (bad CLAUDE_BIN) as an error outcome, not a hang.
  let spawnError = null;
  child.on('error', function (e) { exited = true; spawnError = e; });

  const deadline = loopStart + cycleTimeoutSecs * 1000;
  const POLL_MS = 3000;

  while (true) {
    // CANCEL beats everything.
    if (fs.existsSync(cancelPath)) {
      log('CANCEL file present - killing child group');
      await killChildGroup(child);
      return { kind: 'cancel' };
    }
    if (isGoalDone()) {
      log('goal DONE (all criteria pass) - killing child group');
      await killChildGroup(child);
      return { kind: 'done' };
    }
    if (isRestartReady(loopStart)) {
      log('restart markers detected - killing child group to relaunch fresh');
      await killChildGroup(child);
      let nextPrompt;
      try {
        nextPrompt = fs.readFileSync(nextMdPath, 'utf8').trim();
      } catch (e) {
        log('WARN: could not read NEXT.md: ' + e.message + ' - falling back to current prompt');
        nextPrompt = prompt;
      }
      if (!nextPrompt) {
        log('WARN: NEXT.md is empty - falling back to current prompt');
        nextPrompt = prompt;
      }
      return { kind: 'restart', prompt: nextPrompt };
    }
    if (exited) {
      // Child ended on its own. Re-classify via the same markers (done/restart)
      // because a clean stop may have just landed; else it is an error.
      if (spawnError) {
        log('child spawn error: ' + spawnError.message);
        return { kind: 'error', exitCode: 127 };
      }
      if (isGoalDone()) return { kind: 'done' };
      if (isRestartReady(loopStart)) {
        let nextPrompt = '';
        try { nextPrompt = fs.readFileSync(nextMdPath, 'utf8').trim(); } catch (e) {}
        return { kind: 'restart', prompt: nextPrompt || prompt };
      }
      log('child exited code=' + exitCode + ' stdout-bytes=' + child._stdoutBytes +
          ' without done/restart markers');
      if (child._stderrTail) log('stderr tail: ' + child._stderrTail.slice(-500));
      return { kind: 'error', exitCode: exitCode };
    }
    if (Date.now() > deadline) {
      log('cycle TIMEOUT after ' + cycleTimeoutSecs + 's - killing child group');
      await killChildGroup(child);
      return { kind: 'timeout' };
    }
    await sleep(POLL_MS);
  }
}

// ---------- main loop ----------
async function main() {
  let currentPrompt = readInitialPrompt();

  log('supervisor start | project=' + projectDir + ' company=' + companyDir +
      ' max-cycles=' + maxCycles + ' permission-mode=' + permissionMode +
      ' cycle-timeout-secs=' + cycleTimeoutSecs);
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

    const outcome = await runCycle(sessionId, currentPrompt, loopStart);

    if (outcome.kind === 'cancel') {
      log('CANCEL - stopping supervisor');
      process.exit(0);
    }
    if (outcome.kind === 'done') {
      log('goal DONE - exiting 0');
      process.exit(0);
    }
    if (outcome.kind === 'restart') {
      log('restart - next prompt from NEXT.md (' + outcome.prompt.length + ' chars)');
      currentPrompt = outcome.prompt;
      errorStreak = 0;
      continue;
    }

    // timeout or error: count as an error-streak cycle.
    errorStreak += 1;
    const reason = outcome.kind === 'timeout'
      ? 'cycle timed out after ' + cycleTimeoutSecs + 's'
      : 'claude exited ' + outcome.exitCode + ' without completion or restart state';

    log('WARN cycle ' + cycle + ' - ' + reason +
        ' (error streak ' + errorStreak + '/' + MAX_ERROR_STREAK + ')');

    if (errorStreak >= MAX_ERROR_STREAK) {
      process.stderr.write(
        'ERROR: ' + MAX_ERROR_STREAK + ' consecutive non-restart non-done cycles.\n' +
        'Last outcome: ' + outcome.kind + '\n' +
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

main().catch(function (e) {
  process.stderr.write('FATAL: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
