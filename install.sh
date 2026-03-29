#!/bin/bash
set -e

SKILL_DIR=".claude/skills/company"

if [ -d "$SKILL_DIR" ]; then
  echo "Company already installed at $SKILL_DIR"
  echo "To update: rm -rf $SKILL_DIR && bash install.sh"
  exit 1
fi

mkdir -p "$SKILL_DIR"

if command -v curl &> /dev/null; then
  curl -sL "https://raw.githubusercontent.com/jagmarques/company-skill/main/skill/SKILL.md" -o "$SKILL_DIR/SKILL.md"
elif command -v wget &> /dev/null; then
  wget -q "https://raw.githubusercontent.com/jagmarques/company-skill/main/skill/SKILL.md" -O "$SKILL_DIR/SKILL.md"
else
  echo "Error: curl or wget required"
  exit 1
fi

echo "Installed. Create COMPANY.md, then type /company in Claude Code."
