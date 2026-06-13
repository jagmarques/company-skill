#!/bin/bash
# Quality floor for this repo. Run from anywhere: bash scripts/check.sh
# Checks that every shipped JS file parses, the skill and agent files have
# frontmatter, and no private or banned content leaks into the public files.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
fail=0

note_fail() {
  echo "FAIL: $1"
  fail=1
}

# 1. Every hook, the installer, and the repo scripts must parse as valid JS
for f in hooks/*.js bin/install.js scripts/*.js; do
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
if grep -q '^model: sonnet$' agents/company-worker.md; then
  echo "ok: worker pins sonnet alias"
else
  note_fail "agents/company-worker.md must pin model: sonnet"
fi
if grep -q '^model: haiku$' agents/company-digest.md; then
  echo "ok: digest pins haiku alias"
else
  note_fail "agents/company-digest.md must pin model: haiku"
fi
if grep -hE '^model:' agents/*.md | grep -vE '^model: (sonnet|haiku)$'; then
  note_fail "agent model field outside the allowed aliases sonnet/haiku"
else
  echo "ok: agent model fields stay on allowed aliases"
fi
# scripts/ and hooks/ are intentionally excluded: they hold the price table and
# context-window allowlist which legitimately name versioned ids. The alias check
# at line 69 above is the real agent-frontmatter guard. This grep is belt-and-suspenders.
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
#     Uses git grep so that the .git pointer file in a linked worktree (which
#     contains an absolute path that may include the brand string) is never
#     scanned. Only git-tracked file content is checked.
if git grep -rin 'asqav' -- ':!scripts/check.sh'; then
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

# 11b. Context-guard battle-test: model-aware window detection, de-loop, degrade.
if node tests/context-guard.test.js; then
  echo "ok: context-guard decision matrix"
else
  note_fail "context-guard decision matrix failed"
fi

# 11c. Precompact + session-restore OWNER handling: garbled OWNER must fall through,
#      clean OWNER must scope correctly.
if node tests/hooks-owner.test.js; then
  echo "ok: hooks-owner decision matrix"
else
  note_fail "hooks-owner decision matrix failed"
fi

# 11d. companyDir resolution: no COMPANY_DIR set, exercises cwd-vs-home preference
#      and the clean-OWNER gate (BLOCKER-1 non-vacuous test).
if node tests/companydir-resolution.test.js; then
  echo "ok: companydir resolution matrix"
else
  note_fail "companydir resolution matrix failed"
fi

# 12. Contract checker matrix: field and DEPENDS-ON validation must hold.
if node tests/check-contracts.test.js; then
  echo "ok: contract checker matrix"
else
  note_fail "contract checker matrix failed"
fi

# 13. Codegraph matrix: extraction, ranking, budget enforcement, and the
#     refuse-or-label staleness contract must hold.
if node tests/codegraph.test.js; then
  echo "ok: codegraph matrix"
else
  note_fail "codegraph matrix failed"
fi

# 14. Findings checker matrix: bare SOURCE: fix (8h) and well-formed cases.
if node tests/check-findings.test.js; then
  echo "ok: check-findings decision matrix"
else
  note_fail "check-findings decision matrix failed"
fi

# 15. Restart-debate recorder: missing/empty fields -> exit 1, all present -> artifact written.
if node tests/restart-debate.test.js; then
  echo "ok: restart-debate recorder matrix"
else
  note_fail "restart-debate recorder matrix failed"
fi

# 16. Packaging smoke test: every script referenced in SKILL.md/agents must be
#     in both installer lists. Catches a new script silently left out of install.
if node tests/packaging.test.js; then
  echo "ok: packaging installer coverage"
else
  note_fail "packaging installer coverage failed"
fi

# 16b. Stakes-routing reachability: stakes:high gate is wired in authoring rules, stall
#      counter, reviewer, and critic. Fails against pre-fix code (non-vacuous).
if node tests/stakes-routing.test.js; then
  echo "ok: stakes-routing reachability matrix"
else
  note_fail "stakes-routing reachability matrix failed"
fi

# 17. Doc-command gate: every referenced script exists and no user-facing
#     section in SKILL.md or agents/ uses a bare relative node scripts/x.js.
if node scripts/check-doc-commands.js; then
  echo "ok: doc-command references"
else
  note_fail "doc-command check failed"
fi

# 18. Workflow lint: every uses: pinned to SHA, permissions declared, concurrency on check* (WARN).
if bash scripts/lint-workflows.sh; then
  echo "ok: workflow lint"
else
  note_fail "workflow lint failed"
fi

# 19. SKILL.md bash blocks: syntax-check each fenced bash block.
#     Uses shellcheck when available, falls back to bash -n.
if node scripts/lint-md-bash.js skill/SKILL.md; then
  echo "ok: SKILL.md bash block lint"
else
  note_fail "SKILL.md bash block lint failed"
fi

# 20. Version sync: package.json version must match top ## heading in CHANGELOG.md.
if node scripts/check-version.js; then
  echo "ok: version matches CHANGELOG.md"
else
  note_fail "version/CHANGELOG mismatch"
fi

# 21. Org-parser matrix: HTML-comment stripping, non-roster sections, lead detection.
if node tests/org-parser.test.js; then
  echo "ok: org-parser matrix"
else
  note_fail "org-parser matrix failed"
fi

# 22. Cleanup fail-safe matrix: hasOpenPR returns true on parse error (BUG #5).
if node tests/cleanup-failsafe.test.js; then
  echo "ok: cleanup fail-safe matrix"
else
  note_fail "cleanup fail-safe matrix failed"
fi

# 23. buildOrgTree integration: /api/state must return HTTP 200 with a valid
#     org tree. Catches the activeCycle dangling-ref regression (HTTP 500).
if node tests/buildorgtree-integration.test.js; then
  echo "ok: buildOrgTree integration (/api/state returns valid tree)"
else
  note_fail "buildOrgTree integration failed (/api/state returned error)"
fi

# 24. Dashboard D1/D4 non-vacuous tests: usedTokens includes output_tokens,
#     humanizeModel returns a friendly label, layoutTree places 21 nodes with
#     zero pairwise overlaps and no negative x.
if node tests/dashboard-d1-d4.test.js; then
  echo "ok: dashboard D1/D4 tests (context fill + model label + tree layout)"
else
  note_fail "dashboard D1/D4 tests failed"
fi

# 25. Autoloop supervisor: threshold-driven restart-via-resume test (under threshold
#     resumes the same session, crossing threshold drives /company restart then a fresh
#     session seeded from NEXT.md, no --continue, real-schema done, CANCEL, and the
#     fill-ignoring non-vacuity proof that never restarts).
if node tests/autoloop.test.js; then
  echo "ok: autoloop supervisor matrix"
else
  note_fail "autoloop supervisor matrix failed"
fi

if [ "$fail" -ne 0 ]; then
  echo "CHECKS FAILED"
  exit 1
fi
echo "ALL CHECKS PASSED"
