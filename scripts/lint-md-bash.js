#!/usr/bin/env node
// Extract ```bash blocks from Markdown files and check each for shell errors.
// If shellcheck is on PATH, pipe each block through it.
// If not, write each block to a temp file and run `bash -n` (syntax check).
// Remaps reported line numbers back to the source .md file.
// Exit 1 if any block has errors, naming the block and issue.
// Zero deps - Node builtins only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: lint-md-bash.js <file.md> [file2.md ...]');
  process.exit(2);
}

function hasCmd(cmd) {
  const r = spawnSync('command', ['-v', cmd], { shell: true, encoding: 'utf8' });
  return r.status === 0;
}

const useShellcheck = hasCmd('shellcheck');

// Extract all ```bash ... ``` blocks from text.
// Returns [{startLine, code}] where startLine is 1-based line of the opening fence.
function extractBashBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let inBlock = false;
  let blockStart = 0;
  let blockLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^```bash\s*$/.test(line)) {
      inBlock = true;
      blockStart = i + 1; // 1-based
      blockLines = [];
    } else if (inBlock && /^```\s*$/.test(line)) {
      inBlock = false;
      blocks.push({ startLine: blockStart, code: blockLines.join('\n') });
    } else if (inBlock) {
      blockLines.push(line);
    }
  }
  return blocks;
}

let failed = 0;

for (const mdFile of files) {
  if (!fs.existsSync(mdFile)) {
    console.error('lint-md-bash: file not found: ' + mdFile);
    failed++;
    continue;
  }
  const text = fs.readFileSync(mdFile, 'utf8');
  const blocks = extractBashBlocks(text);

  if (!blocks.length) {
    console.log('ok: ' + mdFile + ' - no bash blocks found');
    continue;
  }

  for (let bi = 0; bi < blocks.length; bi++) {
    const { startLine, code } = blocks[bi];
    const blockLabel = mdFile + ':' + startLine + ' (bash block ' + (bi + 1) + ')';

    // Write block to a temp file with shellcheck hint header
    const tmpFile = path.join(os.tmpdir(), 'lint-md-bash-' + process.pid + '-' + bi + '.sh');
    // shellcheck shell=bash suppresses SC2148 (no shebang) when using shellcheck
    fs.writeFileSync(tmpFile, '# shellcheck shell=bash\n' + code + '\n');

    let ok = true;
    let errorMsg = '';

    if (useShellcheck) {
      // --severity=error: only fail on errors, not warnings/info/style.
      // Documented bash snippets often skip quoting for brevity (SC2086 info),
      // so info-level findings are reported but do not block CI.
      const r = spawnSync(
        'shellcheck',
        ['--shell=bash', '--exclude=SC2148', '--severity=error', tmpFile],
        { encoding: 'utf8' }
      );
      if (r.status !== 0) {
        ok = false;
        // Remap line numbers: shellcheck reports lines in tmpFile, offset by 1 (the header line)
        const rawOut = (r.stdout || '') + (r.stderr || '');
        // Replace "tmpFile:N:" with "mdFile:(startLine + N - 2):" for readability
        errorMsg = rawOut.replace(
          new RegExp(tmpFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):', 'g'),
          (_, n) => mdFile + ':' + (startLine + parseInt(n, 10) - 2) + ':'
        );
      }
    } else {
      // Zero-dep fallback: bash -n (syntax only)
      const r = spawnSync('bash', ['-n', tmpFile], { encoding: 'utf8' });
      if (r.status !== 0) {
        ok = false;
        const rawOut = (r.stderr || r.stdout || '').trim();
        // Remap line numbers from tmpFile reference
        errorMsg = rawOut.replace(
          new RegExp(tmpFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(line\\s+)?(\\d+)', 'g'),
          (_, _prefix, n) => mdFile + ':' + (startLine + parseInt(n, 10) - 2)
        );
      }
    }

    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }

    if (ok) {
      console.log('ok: ' + blockLabel + (useShellcheck ? ' (shellcheck)' : ' (bash -n)'));
    } else {
      console.error('FAIL: ' + blockLabel);
      if (errorMsg) console.error(errorMsg);
      failed++;
    }
  }
}

if (failed) {
  process.exit(1);
}
