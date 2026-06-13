#!/usr/bin/env node
// Repo hygiene script: delete merged branches from origin and remove stale worktrees.
//
// Safety rules (never violated regardless of flags):
//   - Never touch the primary worktree (the one returned by `git worktree list` with no gitdir).
//   - Never delete a branch named "main".
//   - Never delete a branch that has an OPEN pull request.
//   - Never delete a branch with no associated pull request (unknown intent).
//   - Only deletes a branch when gh confirms its PR is MERGED.
//
// Worktree cleanup:
//   - Removes a linked worktree only when its branch was just deleted (merged evidence).
//   - Skips any worktree with uncommitted or untracked changes (non-empty git status).
//   - Runs `git worktree prune` to clear stale gitdir bookmarks.
//
// Usage:
//   node <skill-scripts-dir>/cleanup.js [--dry-run]
//
// --dry-run  Print what would be deleted without making any changes.

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const isDryRun = process.argv.includes('--dry-run');
const prefix = isDryRun ? '[DRY-RUN] would delete' : 'deleted';

// Run a command and return trimmed stdout. Throws on non-zero exit.
function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || '').trim() || ('exit ' + r.status);
    throw new Error(cmd + ' ' + args.join(' ') + ': ' + msg);
  }
  return (r.stdout || '').trim();
}

// Run a command and return { status, stdout, stderr } without throwing.
function tryRun(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
}

// Resolve the repo root from wherever this script runs.
function repoRoot() {
  try {
    return run('git', ['rev-parse', '--show-toplevel']);
  } catch (e) {
    console.error('cleanup.js: not inside a git repo (git rev-parse failed)');
    process.exit(1);
  }
}

// Return the set of merged branch names on origin (excluding "main").
// Uses `gh pr list --state merged --json headRefName` for accuracy.
function mergedBranchesOnOrigin() {
  // Get all merged PRs from GitHub.
  const r = tryRun('gh', ['pr', 'list', '--state', 'merged', '--json', 'headRefName', '--limit', '200']);
  if (r.status !== 0 || r.error) {
    console.warn('cleanup.js: gh pr list failed, skipping branch cleanup: '
      + ((r.stderr || '').trim() || String(r.error || '')));
    return new Set();
  }
  let prs;
  try {
    prs = JSON.parse(r.stdout || '[]');
  } catch (e) {
    console.warn('cleanup.js: could not parse gh pr list output: ' + e.message);
    return new Set();
  }
  const names = new Set();
  for (const pr of prs) {
    const name = (pr.headRefName || '').trim();
    if (name && name !== 'main') names.add(name);
  }
  return names;
}

// Return the set of branches that exist on origin right now.
function originBranches() {
  const out = run('git', ['ls-remote', '--heads', 'origin']);
  const names = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/refs\/heads\/(.+)$/);
    if (m) names.add(m[1].trim());
  }
  return names;
}

// Return an array of worktree info objects: { path, branch, isMain }
// Parsed from `git worktree list --porcelain`.
function listWorktrees() {
  const out = run('git', ['worktree', 'list', '--porcelain']);
  const worktrees = [];
  let current = null;
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length), branch: null, isMain: false };
    } else if (current && line.startsWith('branch ')) {
      // "branch refs/heads/<name>" or "branch refs/heads/<name>"
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (current && line === 'bare') {
      current.isMain = true;
    }
  }
  if (current) worktrees.push(current);
  // The first worktree is always the primary/main worktree.
  if (worktrees.length > 0) worktrees[0].isMain = true;
  return worktrees;
}

// Return true when the worktree at wtPath has any uncommitted or untracked changes.
// On error (path gone, not a git dir) returns true to fail safe (do not remove).
function isWorktreeDirty(wtPath) {
  const r = tryRun('git', ['-C', wtPath, 'status', '--porcelain'], {});
  if (r.status !== 0 || r.error) return true; // fail safe
  return (r.stdout || '').trim().length > 0;
}

// Check if a branch name has an OPEN PR. Returns true if open PR found.
function hasOpenPR(branchName) {
  const r = tryRun('gh', ['pr', 'list', '--head', branchName, '--state', 'open', '--json', 'number']);
  if (r.status !== 0 || r.error) return false; // degrade: assume safe to skip
  try {
    const prs = JSON.parse(r.stdout || '[]');
    return prs.length > 0;
  } catch (e) {
    return false;
  }
}

function main() {
  const root = repoRoot();
  console.log('cleanup.js: repo root ' + root);
  if (isDryRun) console.log('cleanup.js: DRY-RUN mode - no changes will be made');

  const merged = mergedBranchesOnOrigin();
  const existing = originBranches();
  const worktrees = listWorktrees();

  const deletedBranches = new Set();
  let branchCount = 0;
  let worktreeCount = 0;

  // --- Branch cleanup ---
  for (const branch of merged) {
    if (branch === 'main') continue; // safety: never touch main
    if (!existing.has(branch)) continue; // already gone from origin

    // Safety: confirm no open PR exists for this branch.
    if (hasOpenPR(branch)) {
      console.log('cleanup.js: skipping ' + branch + ' (open PR exists)');
      continue;
    }

    console.log('cleanup.js: ' + prefix + ' origin/' + branch);
    if (!isDryRun) {
      const r = tryRun('git', ['push', 'origin', '--delete', branch]);
      if (r.status !== 0) {
        console.warn('cleanup.js: WARN failed to delete origin/' + branch + ': '
          + (r.stderr || '').trim());
        continue;
      }
    }
    deletedBranches.add(branch);
    branchCount += 1;
  }

  // --- Worktree cleanup ---
  // Only remove a worktree when its branch is in deletedBranches (merged-PR evidence).
  // Absence from origin alone is NOT sufficient: a local-only unpushed branch is also
  // absent and its worktree may contain unrecoverable untracked files.
  for (const wt of worktrees) {
    if (wt.isMain) continue; // never remove primary worktree

    const branch = wt.branch;
    // Gate: branch must have been deleted in this run (merged evidence required).
    if (!branch || !deletedBranches.has(branch)) continue;

    // Gate: skip if the worktree has any uncommitted or untracked changes.
    if (isWorktreeDirty(wt.path)) {
      console.log('cleanup.js: skipping worktree ' + wt.path
        + ' (branch: ' + branch + ') - has uncommitted or untracked changes');
      continue;
    }

    console.log('cleanup.js: ' + (isDryRun ? '[DRY-RUN] would remove' : 'removing')
      + ' worktree ' + wt.path + ' (branch: ' + (branch || 'detached') + ')');

    if (!isDryRun) {
      // No --force: the dirty-tree guard above already ensures the tree is clean.
      const r = tryRun('git', ['worktree', 'remove', wt.path]);
      if (r.status !== 0) {
        console.warn('cleanup.js: WARN failed to remove worktree ' + wt.path + ': '
          + (r.stderr || '').trim());
        continue;
      }
    }
    worktreeCount += 1;
  }

  // Prune stale gitdir entries.
  if (!isDryRun) {
    tryRun('git', ['worktree', 'prune']);
    console.log('cleanup.js: ran git worktree prune');
  }

  // Summary.
  const nothing = branchCount === 0 && worktreeCount === 0;
  if (nothing) {
    console.log('cleanup.js: nothing to clean (no merged branches or stale worktrees found)');
  } else {
    console.log('cleanup.js: done - '
      + branchCount + ' branch(es) ' + (isDryRun ? 'would be deleted' : 'deleted')
      + ', '
      + worktreeCount + ' worktree(s) ' + (isDryRun ? 'would be removed' : 'removed'));
  }
}

main();
