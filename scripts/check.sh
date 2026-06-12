#!/bin/bash
# Quality floor for this repo. Run from anywhere: bash scripts/check.sh
# Checks that every shipped JS file parses, the skill and agent files have
# frontmatter, and no private or banned content leaks into the public files.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

note_fail() {
  echo "FAIL: $1"
  fail=1
}

# 1. Every hook and the installer must parse as valid JS
for f in hooks/*.js bin/install.js; do
  if node --check "$f" 2>/dev/null; then
    echo "ok: node --check $f"
  else
    node --check "$f" || true
    note_fail "$f does not parse"
  fi
done

# 2. install.sh must parse as valid shell
if bash -n install.sh 2>/dev/null; then
  echo "ok: bash -n install.sh"
else
  note_fail "install.sh does not parse"
fi

# 3. SKILL.md frontmatter exists and names the skill
if [ "$(head -1 skill/SKILL.md)" = "---" ] && grep -q '^name: company$' skill/SKILL.md; then
  echo "ok: SKILL.md frontmatter"
else
  note_fail "skill/SKILL.md frontmatter missing or name field absent"
fi

# 4. Agent frontmatter follows the model policy. Every agent file has
#    frontmatter with a name field. Strong roles (lead, reviewer, critic)
#    carry NO model field because omission inherits the session model.
#    Worker pins the sonnet alias, digest pins the haiku alias, and no
#    agent or skill file may name a versioned model.
for f in agents/*.md; do
  if [ "$(head -1 "$f")" = "---" ] && grep -q '^name: ' "$f"; then
    echo "ok: frontmatter $f"
  else
    note_fail "$f missing frontmatter or name field"
  fi
done
for f in agents/company-lead.md agents/company-reviewer.md agents/company-critic.md; do
  if grep -q '^model:' "$f"; then
    note_fail "$f carries a model field (strong roles inherit by omission)"
  else
    echo "ok: no model field in $f"
  fi
done
grep -q '^model: sonnet$' agents/company-worker.md \
  && echo "ok: worker pins sonnet alias" \
  || note_fail "agents/company-worker.md must pin model: sonnet"
grep -q '^model: haiku$' agents/company-digest.md \
  && echo "ok: digest pins haiku alias" \
  || note_fail "agents/company-digest.md must pin model: haiku"
if grep -hE '^model:' agents/*.md | grep -vE '^model: (sonnet|haiku)$'; then
  note_fail "agent model field outside the allowed aliases sonnet/haiku"
else
  echo "ok: agent model fields stay on allowed aliases"
fi
if grep -rinE 'claude-[a-z]+-[0-9]' agents/ skill/; then
  note_fail "versioned model name found in agents or skill"
else
  echo "ok: no versioned model names"
fi

# 5. package.json parses
if node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" 2>/dev/null; then
  echo "ok: package.json parses"
else
  note_fail "package.json is invalid JSON"
fi

# 6. No private rule-number references (e.g. references to a numbered rule
#    in someone's personal CLAUDE.md) in shipped files
if grep -rnE 'CLAUDE\.md +(rule +)?[0-9]+\.[0-9]+|\(CLAUDE\.md +[0-9]' \
    --include='*.md' --include='*.js' --include='*.sh' --include='*.template' \
    --exclude-dir=.git --exclude-dir=node_modules --exclude=check.sh .; then
  note_fail "private rule-number reference found"
else
  echo "ok: no private rule references"
fi

# 7. No bare rule-number references either ("rule 1.2" without naming a
#    file is still a leak from someone's private rule set)
if grep -rinE 'rule [0-9]+\.[0-9]+' \
    --include='*.md' --include='*.js' --include='*.sh' --include='*.template' \
    --exclude-dir=.git --exclude-dir=node_modules --exclude=check.sh .; then
  note_fail "bare rule-number reference found"
else
  echo "ok: no bare rule references"
fi

# 8. No hardcoded IP addresses (loopback and wildcard excepted)
if grep -rnE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' \
    --include='*.md' --include='*.js' --include='*.sh' --include='*.template' \
    --exclude-dir=.git --exclude-dir=node_modules --exclude=check.sh . \
    | grep -vE '127\.0\.0\.1|0\.0\.0\.0'; then
  note_fail "hardcoded IP address found"
else
  echo "ok: no hardcoded IPs"
fi

# 9. No em dashes in shipped files
EMDASH=$(printf '\342\200\224')
if grep -rn "$EMDASH" \
    --include='*.md' --include='*.js' --include='*.sh' --include='*.template' \
    --exclude-dir=.git --exclude-dir=node_modules --exclude=check.sh .; then
  note_fail "em dash found"
else
  echo "ok: no em dashes"
fi

# 10. No leaked operator brand names anywhere in the tree. This is a generic
#     public tool and must never name the company of whoever maintains it.
#     check.sh is excluded only because the banned word list lives here.
if grep -rin 'asqav' --exclude-dir=.git --exclude-dir=node_modules \
    --exclude=check.sh .; then
  note_fail "leaked brand name found"
else
  echo "ok: no leaked brand names"
fi

# 11. Stop-guard decision-logic matrix: the fail-closed behavior is load-bearing
#     and must not regress silently behind a green parse check.
if node tests/stop-guard.test.js; then
  echo "ok: stop-guard decision matrix"
else
  note_fail "stop-guard decision matrix failed"
fi

# 12. Contract checker matrix: field and DEPENDS-ON validation must hold.
if node tests/check-contracts.test.js; then
  echo "ok: contract checker matrix"
else
  note_fail "contract checker matrix failed"
fi

if [ "$fail" -ne 0 ]; then
  echo "CHECKS FAILED"
  exit 1
fi
echo "ALL CHECKS PASSED"
