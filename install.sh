#!/bin/bash
set -e

REPO="https://raw.githubusercontent.com/jagmarques/company-skill/main"

# Install skill globally
mkdir -p "$HOME/.claude/skills/company"
curl -sL "$REPO/skill/SKILL.md" -o "$HOME/.claude/skills/company/SKILL.md" 2>/dev/null || \
  wget -q "$REPO/skill/SKILL.md" -O "$HOME/.claude/skills/company/SKILL.md" 2>/dev/null || \
  { echo "Error: curl or wget required"; exit 1; }

# Install commands globally
mkdir -p "$HOME/.claude/commands/company"
for cmd in run status resume; do
  curl -sL "$REPO/commands/$cmd.md" -o "$HOME/.claude/commands/company/$cmd.md" 2>/dev/null || true
done

# Install agents globally
mkdir -p "$HOME/.claude/agents"
for agent in lead worker reviewer critic digest; do
  curl -sL "$REPO/agents/company-$agent.md" -o "$HOME/.claude/agents/company-$agent.md" 2>/dev/null || true
done

# Create COMPANY.md template in current directory if missing
if [ ! -f "COMPANY.md" ]; then
  curl -sL "$REPO/COMPANY.md.template" -o "COMPANY.md" 2>/dev/null || true
  [ -f "COMPANY.md" ] && echo "Created COMPANY.md template. Edit it with your team."
fi

# Gitignore .company/
grep -q "^\.company/" .gitignore 2>/dev/null || echo ".company/" >> .gitignore 2>/dev/null || true

echo "Installed globally. Available commands:"
echo "  /company           Main skill"
echo "  /company:run       Run with a goal"
echo "  /company:status    Check status"
echo "  /company:resume    Continue from last session"
