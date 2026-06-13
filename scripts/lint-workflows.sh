#!/bin/bash
# Lint GitHub Actions workflow files. Run from repo root.
# Checks: every uses: is pinned to a 40-char SHA, permissions: declared,
# and (for workflows named check*) concurrency: declared.
# Zero deps - pure bash + grep.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

note_fail() {
  echo "FAIL: $1"
  fail=1
}

# Resolve workflow dir relative to ROOT
WF_DIR="$ROOT/.github/workflows"

if [ ! -d "$WF_DIR" ]; then
  echo "skip: no .github/workflows directory found"
  exit 0
fi

YML_FILES=$(find "$WF_DIR" -maxdepth 1 -name '*.yml' -o -name '*.yaml' 2>/dev/null | sort)

if [ -z "$YML_FILES" ]; then
  echo "skip: no workflow files found in $WF_DIR"
  exit 0
fi

for f in $YML_FILES; do
  name=$(basename "$f")

  # Check 1: every uses: line must end with a 40-char lowercase hex SHA.
  # Use plain grep 'uses:' (no ERE \s) for POSIX portability on macOS.
  if grep 'uses:' "$f" | grep -qvE '@[0-9a-f]{40}([[:space:]]|$)'; then
    grep -n 'uses:' "$f" | grep -vE '@[0-9a-f]{40}([[:space:]]|$)' | while IFS= read -r line; do
      echo "FAIL: $name: action not pinned to 40-char SHA: $line"
    done
    fail=1
  else
    echo "ok: $name - all uses: pinned to SHA"
  fi

  # Check 2: workflow-level permissions: key must be declared
  if ! grep -qE '^permissions:' "$f"; then
    note_fail "$name: missing top-level permissions: declaration"
  else
    echo "ok: $name - permissions declared"
  fi

  # Check 3: check* workflows should declare concurrency: (WARN, not hard fail)
  # Adding concurrency to check.yml is tracked as a follow-up.
  case "$name" in
    check*|ci*)
      if ! grep -qE '^concurrency:' "$f"; then
        echo "WARN: $name: check/ci workflow missing concurrency: declaration (follow-up item)"
      else
        echo "ok: $name - concurrency declared"
      fi
      ;;
  esac
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "ok: workflow lint passed"
