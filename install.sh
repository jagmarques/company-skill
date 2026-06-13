#!/bin/bash
# Installs the /company skill, commands, agents, and hooks.
# Idempotent: re-running overwrites copied files and never duplicates hook entries.
set -e

REPO="https://raw.githubusercontent.com/jagmarques/company-skill/main"

fetch() {
  curl -fsSL "$1" -o "$2" 2>/dev/null || wget -q "$1" -O "$2" 2>/dev/null
}

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || {
  echo "Error: curl or wget required"
  exit 1
}

# Skill
mkdir -p "$HOME/.claude/skills/company"
fetch "$REPO/skill/SKILL.md" "$HOME/.claude/skills/company/SKILL.md" || {
  echo "Error: could not download SKILL.md"
  exit 1
}

# Commands
mkdir -p "$HOME/.claude/commands/company"
for cmd in run status resume; do
  fetch "$REPO/commands/$cmd.md" "$HOME/.claude/commands/company/$cmd.md" || echo "Warning: failed to download command $cmd"
done

# Agents
mkdir -p "$HOME/.claude/agents"
for agent in lead worker reviewer critic digest; do
  fetch "$REPO/agents/company-$agent.md" "$HOME/.claude/agents/company-$agent.md" || echo "Warning: failed to download agent company-$agent"
done

# Scripts (runtime dependencies referenced from SKILL.md).
# check.sh and test files stay in the repo only and are not installed.
mkdir -p "$HOME/.claude/skills/company/scripts"
for script in codegraph.js check-contracts.js check-findings.js restart-debate.js; do
  fetch "$REPO/scripts/$script" "$HOME/.claude/skills/company/scripts/$script" || echo "Warning: failed to download script $script"
done

# Hooks
mkdir -p "$HOME/.claude/hooks"
for pair in "stop-guard company-stop-guard" "context-guard company-context-guard" "precompact company-precompact" "session-restore company-session-restore"; do
  src="${pair%% *}"
  dest="${pair##* }"
  fetch "$REPO/hooks/$src.js" "$HOME/.claude/hooks/$dest.js" || echo "Warning: failed to download hook $src"
done

# JSON editing from shell is unsafe without a JSON tool. Use node when available
# and print exact manual steps otherwise. The merge is idempotent.
if command -v node >/dev/null 2>&1; then
  node <<'EOF'
const fs = require('fs');
const path = require('path');
const os = require('os');
const home = os.homedir();
const hooksDir = path.join(home, '.claude', 'hooks');
const settingsPath = path.join(home, '.claude', 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) {}
if (!settings.hooks) settings.hooks = {};
function ensure(event, marker, entry) {
  if (!settings.hooks[event]) settings.hooks[event] = [];
  const present = settings.hooks[event].some(h => (h.hooks || []).some(hh => (hh.command || '').includes(marker)));
  if (!present) settings.hooks[event].push(entry);
}
ensure('Stop', 'company-stop-guard', { hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'company-stop-guard.js')}"`, timeout: 10 }] });
ensure('Stop', 'company-context-guard', { hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'company-context-guard.js')}"`, timeout: 10 }] });
ensure('PreCompact', 'company-precompact', { hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'company-precompact.js')}"`, timeout: 10 }] });
ensure('SessionStart', 'company-session-restore', { matcher: 'compact', hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'company-session-restore.js')}"`, timeout: 10 }] });
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const tmp = settingsPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
fs.renameSync(tmp, settingsPath);
console.log('Hooks registered in ' + settingsPath);
EOF
else
  cat <<EOF

node was not found, so the hook files were copied but NOT registered.
The hooks need node at runtime anyway, so install node, then add this to
the "hooks" section of ~/.claude/settings.json (merge with what is there):

  "Stop": [
    { "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/company-stop-guard.js\"", "timeout": 10 }] },
    { "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/company-context-guard.js\"", "timeout": 10 }] }
  ],
  "PreCompact": [{ "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/company-precompact.js\"", "timeout": 10 }] }],
  "SessionStart": [{ "matcher": "compact", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/company-session-restore.js\"", "timeout": 10 }] }]

EOF
fi

# Create COMPANY.md template in current directory if missing
if [ ! -f "COMPANY.md" ]; then
  fetch "$REPO/COMPANY.md.template" "COMPANY.md" || true
  [ -f "COMPANY.md" ] && echo "Created COMPANY.md template. Edit it with your team."
fi

# Gitignore .company/ (only inside a git repo)
if [ -d ".git" ]; then
  grep -q "^\.company/" .gitignore 2>/dev/null || echo ".company/" >> .gitignore
fi

echo "Installed. Available commands:"
echo "  /company           Main skill"
echo "  /company:run       Run with a goal"
echo "  /company:status    Check status"
echo "  /company:resume    Continue from last session"
echo "Cancel a run: touch .company/CANCEL"
