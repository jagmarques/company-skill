#!/bin/bash
set -e

REPO="https://raw.githubusercontent.com/jagmarques/company-skill/main"
SKILL_DIR="$HOME/.claude/skills/company"

mkdir -p "$SKILL_DIR"

# Download skill globally
curl -sL "$REPO/skill/SKILL.md" -o "$SKILL_DIR/SKILL.md" 2>/dev/null || \
  wget -q "$REPO/skill/SKILL.md" -O "$SKILL_DIR/SKILL.md" 2>/dev/null || \
  { echo "Error: curl or wget required"; exit 1; }

# Copy template if no COMPANY.md exists in current directory
if [ ! -f "COMPANY.md" ]; then
  curl -sL "$REPO/COMPANY.md.template" -o "COMPANY.md" 2>/dev/null || \
    wget -q "$REPO/COMPANY.md.template" -O "COMPANY.md" 2>/dev/null || true
  echo "Created COMPANY.md template. Edit it with your team."
fi

# Add .company/ to gitignore
grep -q "^\.company/" .gitignore 2>/dev/null || echo ".company/" >> .gitignore 2>/dev/null || true

echo "Installed globally. Works from any directory."
echo "Edit COMPANY.md, then type /company in Claude Code."
