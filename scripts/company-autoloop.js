#!/usr/bin/env node
// company-autoloop.js - External supervisor for /company auto-restart cycles.
//
// WHY THIS IS A SEPARATE SCRIPT (not native hooks):
//   A fully unattended detect->restart->fresh-context loop is IMPOSSIBLE with
//   Claude Code native features alone. Stop-hook decision:block keeps the SAME
//   context (does not reset). /clear is interactive-only. Auto-compaction
//   summarizes in-session, never resets. Fresh context requires a NEW process
//   invocation - i.e. this external script. See auto-restart-research.md.
//
// VALIDATED HEADLESS REALITY (orchestrator real 1% runs, 2026-06-13):
//   A headless `claude -p` session does NOT self-trigger /company restart. The
//   company Stop guards (stop-guard, context-guard) are effectively INTERACTIVE
//   ONLY: a -p session completes its turn and EXITS regardless of decision:block,
//   so it never writes NEXT.md / RESTART_DEBATE_CONFIRMED on its own. The earlier
//   "wait for the child to self-restart" premise was therefore WRONG for headless.
//   THE FIX, PROVEN LIVE: the supervisor must DRIVE the restart. Running
//   `claude -p --resume <sessionId> "/company restart"` executes restart mode
//   headlessly and writes NEXT.md (+ RESTART_DEBATE_CONFIRMED after the full
//   3-role debate). So the supervisor owns the threshold decision itself.
//
// HOW IT WORKS (threshold-driven, restart-via-resume):
//   One logical run is MANY sessions. The supervisor tracks the work session's
//   context FILL itself (the guards do not fire headless) and drives turns until
//   the threshold is crossed, then drives a /company restart for fresh context.
//     1. Fresh session: spawn `claude -p --session-id <uuid> ... "<goal-or-NEXT>"`.
//        Continuation of the SAME session under threshold: `--resume <uuid>`.
//        Each -p call runs to completion and exits (expected headless behavior).
//     2. After a turn: CANCEL -> exit 0. Goal done (criteria all pass) -> exit 0.
//     3. Compute fill from the transcript jsonl (last assistant usage block) and
//        the model window. Log it.
//     4. fill >= threshold: DRIVE `claude -p --resume <uuid> "/company restart"`,
//        wait for RESTART_DEBATE_CONFIRMED + a fresh NEXT.md, then seed a NEW
//        --session-id from NEXT.md. THIS is the fresh-context handoff.
//     5. fill < threshold: continue the SAME session another turn via --resume.
//
//   --resume is used in exactly two legitimate places: continuing the same work
//   session under threshold, and driving /company restart on that session. The
//   fresh continuation AFTER a restart is ALWAYS a brand-new --session-id seeded
//   from NEXT.md. --continue is NEVER used, and --resume NEVER carries work into a
//   new logical cycle - that handoff is always a new session id.
//
// USAGE:
//   node scripts/company-autoloop.js [options] "<goal>"
//   node scripts/company-autoloop.js [options] --prompt-file /path/to/goal.txt
//
// OPTIONS:
//   --project-dir <path>   Project dir the /company run targets (default: cwd)
//   --company-dir <path>   Override .company dir (default: <project-dir>/.company)
//   --max-turns <n>        Hard cap on work turns across all sessions (default: 100)
//   --permission-mode <m>  claude --permission-mode value (default: bypassPermissions)
//   --prompt-file <path>   Read initial goal from file instead of CLI arg
//   --restart-timeout-secs <n>  Max wait for restart markers after driving it (default: 420)
//   --projects-dir <path>  Override the ~/.claude/projects transcript root (testing)
//   --help                 Show this message
//
// ENV:
//   CLAUDE_BIN                 Path to the claude binary (default: claude)
//   COMPANY_DIR                Overrides --company-dir
//   COMPANY_TRANSCRIPT_DIR     Overrides the transcript projects root (testing)
//   COMPANY_CONTEXT_THRESHOLD  Fill fraction or percent that triggers restart (default: 0.50)
//   COMPANY_CONTEXT_WINDOW     Force the context window size (overrides model detection)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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

const maxTurns = parseInt(argValue('--max-turns') || '100', 10);
const permissionMode = argValue('--permission-mode') || 'bypassPermissions';
const promptFile = argValue('--prompt-file');
const restartTimeoutSecs = parseInt(argValue('--restart-timeout-secs') || '420', 10);
const claudeBin = process.env.CLAUDE_BIN || 'claude';

// Transcript projects root: env wins, then --projects-dir, then ~/.claude/projects.
const projectsDir = process.env.COMPANY_TRANSCRIPT_DIR ||
  argValue('--projects-dir') ||
  path.join(os.homedir(), '.claude', 'projects');

// Positional goal: last non-flag arg that is not a flag value
let goalArg = null;
const flagsWithValues = new Set([
  '--project-dir', '--company-dir', '--max-turns',
  '--permission-mode', '--prompt-file', '--restart-timeout-secs', '--projects-dir',
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

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
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

// ---------- context-window detection (mirrors hooks/context-guard.js) ----------
// Known 1M-context model id substrings. Unknown/null defaults to 1M (fail-open),
// matching the guard so the supervisor never false-fires a restart on an unknown id.
const KNOWN_1M_SUBSTRINGS = [
  '[1m]',
  'claude-opus-4',
  'claude-opus-4-5',
  'claude-opus-4-8',
];
const DEFAULT_WINDOW = 1000000;
const WINDOW_200K = 200000;

function is1MModel(modelId) {
  if (!modelId) return true; // unknown defaults to 1M (fail-open)
  const lower = modelId.toLowerCase();
  for (let i = 0; i < KNOWN_1M_SUBSTRINGS.length; i++) {
    if (lower.indexOf(KNOWN_1M_SUBSTRINGS[i]) !== -1) return true;
  }
  return false;
}

function detectWindow(modelId) {
  const envVal = process.env.COMPANY_CONTEXT_WINDOW;
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (n > 0) return n;
  }
  return is1MModel(modelId) ? DEFAULT_WINDOW : WINDOW_200K;
}

function parseThreshold() {
  const raw = process.env.COMPANY_CONTEXT_THRESHOLD;
  if (!raw) return 0.50;
  const v = parseFloat(raw);
  if (isNaN(v)) return 0.50;
  // accept either fraction (0.5) or percent (50)
  return v > 1 ? v / 100 : v;
}

// Sum every token field that counts against the context window.
// Matches the Claude Code status line: input + cache_read + cache_creation + output.
function usedTokens(usage) {
  return (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.output_tokens || 0);
}

// ---------- locate a session transcript jsonl ----------
// Sessions persist at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. The
// encoded-cwd segment is not worth reconstructing by hand, so glob every project
// dir for <sessionId>.jsonl and take the newest match. Returns null if missing.
function findTranscript(sessionId) {
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].isDirectory()) continue;
    const candidate = path.join(projectsDir, entries[i].name, sessionId + '.jsonl');
    let st;
    try { st = fs.statSync(candidate); } catch (e) { continue; }
    if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = candidate; }
  }
  return best;
}

// ---------- compute the work session's context fill ----------
// Read the LAST assistant usage block from the session transcript, sum the token
// fields, divide by the detected window. A missing transcript is not a crash: log
// a warning and treat fill as 0 so the loop keeps making progress.
function computeFill(sessionId) {
  const transcript = findTranscript(sessionId);
  if (!transcript) {
    log('WARN no transcript found for session ' + sessionId + ' under ' + projectsDir +
        ' - treating fill as 0');
    return { fill: 0, used: 0, window: DEFAULT_WINDOW, modelId: null, transcript: null };
  }
  let lastUsage = null;
  let lastModelId = null;
  try {
    const raw = fs.readFileSync(transcript, 'utf8');
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const inner = msg.message || msg;
      if (inner && inner.role === 'assistant' && inner.usage) {
        lastUsage = inner.usage;
        if (typeof inner.model === 'string') lastModelId = inner.model;
        else if (typeof msg.model === 'string') lastModelId = msg.model;
        break;
      }
    }
  } catch (e) {
    log('WARN could not read transcript ' + transcript + ': ' + e.message + ' - fill 0');
    return { fill: 0, used: 0, window: DEFAULT_WINDOW, modelId: null, transcript };
  }
  if (!lastUsage) {
    return { fill: 0, used: 0, window: DEFAULT_WINDOW, modelId: lastModelId, transcript };
  }
  const used = usedTokens(lastUsage);
  const window = detectWindow(lastModelId);
  return { fill: used / window, used, window, modelId: lastModelId, transcript };
}

// ---------- run one claude -p turn to completion ----------
// freshSession=true seeds a NEW --session-id. Otherwise --resume the same id.
// The prompt argument is the goal/NEXT on a fresh session, the continue nudge on
// a resume, or "/company restart" when restart=true. Each -p call exits on its
// own (expected headless behavior). stdout/stderr are drained so a full pipe
// never blocks the child. Resolves with the child exit code.
function runTurn(opts) {
  return new Promise(function (resolve) {
    const spawnArgs = ['-p'];
    if (opts.freshSession) spawnArgs.push('--session-id', opts.sessionId);
    else spawnArgs.push('--resume', opts.sessionId);
    spawnArgs.push(
      '--output-format', 'stream-json',
      '--verbose',
      '--include-hook-events',
      '--permission-mode', permissionMode,
      opts.prompt
    );

    const spawnEnv = Object.assign({}, process.env, { COMPANY_DIR: companyDir });
    const mode = opts.freshSession ? '--session-id' : '--resume';
    log('spawning: ' + claudeBin + ' -p ' + mode + ' ' + opts.sessionId +
        (opts.label ? ' [' + opts.label + ']' : '') + ' ...');

    const child = spawn(claudeBin, spawnArgs, {
      cwd: projectDir,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    let stdoutBytes = 0;
    child.stdout.on('data', function (d) { stdoutBytes += d.length; });
    child.stderr.on('data', function (d) { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    child.stdout.on('error', function () {});
    child.stderr.on('error', function () {});

    child.on('error', function (e) {
      log('turn spawn error: ' + e.message);
      resolve({ code: 127, stdoutBytes: 0, stderrTail: e.message });
    });
    child.on('exit', function (code) {
      resolve({ code: code, stdoutBytes: stdoutBytes, stderrTail: stderrTail });
    });
  });
}

// ---------- drive a /company restart and wait for the handoff markers ----------
// Runs `claude -p --resume <sessionId> "/company restart"` (restart mode runs the
// full 3-role debate headlessly) then polls for RESTART_DEBATE_CONFIRMED present
// AND a NEXT.md whose mtime is newer than when the restart call started. Returns
// the NEXT.md contents, or null on timeout.
async function driveRestart(sessionId) {
  const restartStart = Date.now();
  // Clear any stale confirmed marker so we only react to THIS restart.
  try { fs.unlinkSync(debateConfirmedPath); } catch (e) {}

  await runTurn({ sessionId: sessionId, freshSession: false, prompt: '/company restart',
    label: 'company restart' });

  const deadline = restartStart + restartTimeoutSecs * 1000;
  while (Date.now() < deadline) {
    let confirmed = false;
    try { confirmed = fs.existsSync(debateConfirmedPath); } catch (e) {}
    if (confirmed) {
      let freshNext = false;
      try { freshNext = fs.statSync(nextMdPath).mtimeMs > restartStart; } catch (e) {}
      if (freshNext) {
        let next = '';
        try { next = fs.readFileSync(nextMdPath, 'utf8').trim(); } catch (e) {}
        if (next) return next;
      }
    }
    await sleep(2000);
  }
  return null;
}

// ---------- main loop ----------
async function main() {
  const initialPrompt = readInitialPrompt();

  log('supervisor start | project=' + projectDir + ' company=' + companyDir +
      ' max-turns=' + maxTurns + ' permission-mode=' + permissionMode +
      ' threshold=' + parseThreshold() + ' restart-timeout-secs=' + restartTimeoutSecs);
  log('initial prompt length=' + initialPrompt.length + ' chars');

  // A logical run = many sessions. sessionId is the current work session.
  let sessionId = randomUUID();
  let prompt = initialPrompt;
  let freshSession = true;

  const threshold = parseThreshold();
  let errorStreak = 0;
  const MAX_ERROR_STREAK = 3;

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Exit-before-work: a CANCEL or an already-done goal short-circuits the turn.
    if (fs.existsSync(cancelPath)) {
      log('CANCEL file present - exiting 0');
      process.exit(0);
    }
    if (isGoalDone()) {
      log('goal DONE (all criteria pass) before turn ' + turn + ' - exiting 0');
      process.exit(0);
    }

    log('turn ' + turn + '/' + maxTurns + ' | session-id=' + sessionId +
        ' | mode=' + (freshSession ? 'fresh' : 'resume'));

    const continuePrompt = freshSession ? prompt
      : 'Continue the /company goal. Keep working the THINK-EXECUTE-VERIFY loop ' +
        'until every criterion passes.';
    const turnResult = await runTurn({
      sessionId: sessionId,
      freshSession: freshSession,
      prompt: continuePrompt,
    });

    // The turn ran. CANCEL and goal-done both win over fill.
    if (fs.existsSync(cancelPath)) {
      log('CANCEL file present after turn ' + turn + ' - exiting 0');
      process.exit(0);
    }
    if (isGoalDone()) {
      log('goal DONE after turn ' + turn + ' - exiting 0');
      process.exit(0);
    }

    // A turn that errored out (bad binary, crash) counts toward the error streak.
    if (turnResult.code !== 0) {
      errorStreak += 1;
      log('WARN turn ' + turn + ' exited ' + turnResult.code +
          ' (error streak ' + errorStreak + '/' + MAX_ERROR_STREAK + ')' +
          (turnResult.stderrTail ? ' stderr: ' + turnResult.stderrTail.slice(-300) : ''));
      if (errorStreak >= MAX_ERROR_STREAK) {
        process.stderr.write(
          'ERROR: ' + MAX_ERROR_STREAK + ' consecutive failed turns.\n' +
          'Last exit code: ' + turnResult.code + '\n' +
          'Check: ' + companyDir + '/NEXT.md + criteria.json + CANCEL\n'
        );
        process.exit(2);
      }
      // Retry the same session, same prompt.
      freshSession = false;
      continue;
    }
    errorStreak = 0;

    // The supervisor owns the threshold decision (the guards do not fire headless).
    const f = computeFill(sessionId);
    const pct = (f.fill * 100).toFixed(1);
    log('turn ' + turn + ' fill=' + pct + '% (' + f.used + '/' + f.window +
        ' tokens, model=' + (f.modelId || 'unknown') + ', threshold=' +
        (threshold * 100).toFixed(0) + '%)');

    if (f.fill >= threshold) {
      // DRIVE the restart on this session, then seed a FRESH session from NEXT.md.
      log('fill >= threshold - driving /company restart on session ' + sessionId);
      const next = await driveRestart(sessionId);
      if (!next) {
        errorStreak += 1;
        log('WARN restart markers did not appear within ' + restartTimeoutSecs +
            's (error streak ' + errorStreak + '/' + MAX_ERROR_STREAK + ')');
        if (errorStreak >= MAX_ERROR_STREAK) {
          process.stderr.write(
            'ERROR: ' + MAX_ERROR_STREAK + ' consecutive restart-drive failures.\n' +
            'The /company restart did not write NEXT.md + RESTART_DEBATE_CONFIRMED.\n'
          );
          process.exit(2);
        }
        // Retry the same session another turn rather than seeding a blank cycle.
        freshSession = false;
        continue;
      }
      log('restart confirmed - fresh-context handoff (NEXT.md ' + next.length + ' chars)');
      sessionId = randomUUID();
      prompt = next;
      freshSession = true;
      errorStreak = 0;
      // Clean the marker so the next restart starts from a clean slate.
      try { fs.unlinkSync(debateConfirmedPath); } catch (e) {}
      continue;
    }

    // Under threshold: continue the SAME session another turn.
    freshSession = false;
  }

  process.stderr.write(
    'ERROR: max-turns (' + maxTurns + ') reached without goal completion.\n' +
    'Increase --max-turns or verify criteria.json.\n'
  );
  process.exit(3);
}

main().catch(function (e) {
  process.stderr.write('FATAL: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
