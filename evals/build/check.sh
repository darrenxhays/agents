#!/usr/bin/env bash
# Static checks for the build skill (no real Codex runs): bash evals/build/check.sh
# Runs the skill's script tests, then checks that every skill file SKILL.md or a
# reference file names exists.
set -uo pipefail
skill="$(cd "$(dirname "$0")/../../skills/build" && pwd)"
status=0

for test in "$skill"/scripts/*.test.sh; do
  if bash "$test" >/dev/null 2>&1; then
    echo "pass  ${test#"$skill"/}"
  else
    echo "FAIL  ${test#"$skill"/}"; status=1
  fi
done

# Paths like ${CLAUDE_SKILL_DIR}/templates/x.md, templates/x.md, scripts/x.sh, reference/x.md.
docs=("$skill/SKILL.md")
[ -d "$skill/reference" ] && docs+=("$skill"/reference/*.md)
missing=0
for path in $(grep -ohE '(templates|scripts|reference)/[A-Za-z0-9._-]+\.(md|sh)' "${docs[@]}" | sort -u); do
  if [ ! -f "$skill/$path" ]; then
    echo "FAIL  missing $path"; missing=1; status=1
  fi
done
[ "$missing" = 0 ] && echo "pass  every named path exists"
exit $status
