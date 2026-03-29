#!/bin/bash
# Claude Swarm installer — copies the skill into your Claude Code project
set -e

SKILL_DIR=".claude/skills/swarm"

if [ -d "$SKILL_DIR" ]; then
  echo "Claude Swarm already installed at $SKILL_DIR"
  echo "To update, remove it first: rm -rf $SKILL_DIR"
  exit 1
fi

mkdir -p "$SKILL_DIR"

# Download skill file
if command -v curl &> /dev/null; then
  curl -sL "https://raw.githubusercontent.com/jagmarques/claude-swarm/main/skill/SKILL.md" -o "$SKILL_DIR/SKILL.md"
elif command -v wget &> /dev/null; then
  wget -q "https://raw.githubusercontent.com/jagmarques/claude-swarm/main/skill/SKILL.md" -O "$SKILL_DIR/SKILL.md"
else
  echo "Error: curl or wget required"
  exit 1
fi

echo "Claude Swarm installed at $SKILL_DIR"
echo ""
echo "Next steps:"
echo "  1. Create a SWARM.md in your project root describing your team"
echo "  2. In Claude Code, type: /swarm"
echo ""
echo "See examples at: https://github.com/jagmarques/claude-swarm/tree/main/examples"
