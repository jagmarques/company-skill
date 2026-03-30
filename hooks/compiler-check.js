#!/usr/bin/env node

// PostToolUse on Edit/Write: run compiler/linter immediately after code changes.
// Catches errors before Claude moves on to the next task.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Read tool input from stdin
let input = '';
try { input = fs.readFileSync('/dev/stdin', 'utf8'); } catch (e) {}

let filePath;
try {
  const data = JSON.parse(input);
  filePath = data.tool_response?.filePath || data.tool_input?.file_path;
} catch (e) {}

if (!filePath) process.exit(0);

const ext = path.extname(filePath);
let cmd = null;

if (['.ts', '.tsx'].includes(ext)) cmd = `npx tsc --noEmit "${filePath}" 2>&1 | head -5`;
else if (['.js', '.jsx'].includes(ext)) cmd = `node --check "${filePath}" 2>&1`;
else if (ext === '.py') cmd = `python3 -c "import py_compile; py_compile.compile('${filePath}', doraise=True)" 2>&1`;
else if (ext === '.json') cmd = `node -e "JSON.parse(require('fs').readFileSync('${filePath}','utf8'))" 2>&1`;

if (!cmd) process.exit(0);

try {
  execSync(cmd, { timeout: 10000 });
} catch (e) {
  const err = (e.stdout?.toString() || e.message).substring(0, 300);
  console.log(JSON.stringify({
    systemMessage: "Compile/syntax error in " + path.basename(filePath) + ": " + err
  }));
}
