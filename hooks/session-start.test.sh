#!/bin/sh
# Self-check for session-start.sh against throwaway home directories: sh hooks/session-start.test.sh
set -e
hook="$(cd "$(dirname "$0")" && pwd)/session-start.sh"
root="$(cd "$(dirname "$0")/.." && pwd)"
rule="For any planning or coding task, use the pragmatic-engineer skill."
block="<!-- BEGIN pragmatic-engineer (managed by the darrenxhays plugin) -->
$rule
<!-- END pragmatic-engineer -->"
fail() { echo "FAIL: $1"; exit 1; }
# Optional second argument: the auto_use plugin option (unset = never configured);
# third: the project's PRAGMATIC_ENGINEER_AUTO_USE override.
run() { HOME="$1" CLAUDE_PLUGIN_ROOT="$root" CLAUDE_PLUGIN_OPTION_AUTO_USE="$2" PRAGMATIC_ENGINEER_AUTO_USE="$3" sh "$hook"; }
codex_home() { h=$(mktemp -d); mkdir "$h/.codex"; }
agents() { cat "$h/.codex/AGENTS.md"; }

# Fresh Codex install: link created, block written, the skill's body injected as valid JSON.
codex_home
out=$(run "$h")
[ "$(readlink "$h/.codex/skills/pragmatic-engineer")" = "$root/skills/pragmatic-engineer" ] || fail "link"
[ "$(agents)" = "$block" ] || fail "block on fresh file"
context=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"])') || fail "invalid JSON"
printf '%s' "$context" | grep -q '^## Stop at the first rung that holds$' || fail "context has the skill body"
printf '%s' "$context" | grep -q '^name: pragmatic-engineer' && fail "context has the frontmatter"
cp "$h/.codex/AGENTS.md" "$h/before"
run "$h" >/dev/null
cmp -s "$h/before" "$h/.codex/AGENTS.md" || fail "rerun changed AGENTS.md"

# Existing AGENTS.md without a trailing newline keeps its last line intact.
codex_home; printf 'Be terse.' > "$h/.codex/AGENTS.md"
run "$h" >/dev/null
[ "$(agents)" = "$(printf 'Be terse.\n\n%s' "$block")" ] || fail "appended onto last line"

# Loose copies of the rule, bulleted or not, are replaced by one block when on...
codex_home; printf 'Be terse.\n- %s\n* %s\n%s  \nUse tabs.\n' "$rule" "$rule" "$rule" > "$h/.codex/AGENTS.md"
run "$h" >/dev/null
[ "$(agents)" = "$(printf 'Be terse.\nUse tabs.\n\n%s' "$block")" ] || fail "loose rules not replaced"
# ...and the block stays where it is, with other lines untouched, on later runs.
printf 'Top.\n%s\nBottom.\n' "$block" > "$h/.codex/AGENTS.md"; cp "$h/.codex/AGENTS.md" "$h/before"
run "$h" >/dev/null
cmp -s "$h/before" "$h/.codex/AGENTS.md" || fail "block moved"

# Off: block and loose rules removed (other lines kept), skill still linked, no Claude context.
codex_home; printf 'Be terse.\n- %s\n%s\nUse tabs.\n' "$rule" "$block" > "$h/.codex/AGENTS.md"
[ -z "$(run "$h" false)" ] || fail "context printed when off"
[ "$(agents)" = "$(printf 'Be terse.\nUse tabs.')" ] || fail "rule not removed"
[ -L "$h/.codex/skills/pragmatic-engineer" ] || fail "link removed when off"

# Off when AGENTS.md is only the block leaves an empty file; off with no file creates none.
codex_home; printf '%s\n' "$block" > "$h/.codex/AGENTS.md"
run "$h" false >/dev/null
[ -e "$h/.codex/AGENTS.md" ] && [ ! -s "$h/.codex/AGENTS.md" ] || fail "block-only file not emptied"
codex_home; run "$h" false >/dev/null
[ ! -e "$h/.codex/AGENTS.md" ] || fail "created AGENTS.md when off"

# Toggling: on, off, on.
codex_home; echo "Be terse." > "$h/.codex/AGENTS.md"
run "$h" true >/dev/null; run "$h" false >/dev/null
[ "$(agents)" = "Be terse." ] || fail "off after on"
run "$h" true | grep -q additionalContext || fail "context when on"
[ "$(agents)" = "$(printf 'Be terse.\n\n%s' "$block")" ] || fail "block not restored"

# A begin marker without its end keeps the lines after it.
codex_home; printf 'Top.\n<!-- BEGIN pragmatic-engineer (managed by the darrenxhays plugin) -->\nKeep me.\n' > "$h/.codex/AGENTS.md"
run "$h" false >/dev/null
[ "$(agents)" = "$(printf 'Top.\nKeep me.')" ] || fail "unterminated block lost lines"

# A symlinked AGENTS.md stays a symlink, on and off.
codex_home; echo "Be terse." > "$h/real.md"; ln -s "$h/real.md" "$h/.codex/AGENTS.md"
run "$h" >/dev/null
[ -L "$h/.codex/AGENTS.md" ] && grep -qxF "$rule" "$h/real.md" || fail "symlink replaced when on"
run "$h" false >/dev/null
[ -L "$h/.codex/AGENTS.md" ] && [ "$(cat "$h/real.md")" = "Be terse." ] || fail "symlink replaced when off"

# A real skill directory is never replaced.
h=$(mktemp -d); mkdir -p "$h/.codex/skills/pragmatic-engineer"
run "$h" >/dev/null
[ -d "$h/.codex/skills/pragmatic-engineer" ] && [ ! -L "$h/.codex/skills/pragmatic-engineer" ] || fail "replaced real dir"

# Off globally, on in this project: Claude context printed, Codex block still removed.
codex_home; printf '%s\n' "$block" > "$h/.codex/AGENTS.md"
run "$h" false true | grep -q additionalContext || fail "context when on in project"
[ ! -s "$h/.codex/AGENTS.md" ] || fail "project override reached AGENTS.md"

# On globally, off in this project: no Claude context, Codex block kept.
codex_home
[ -z "$(run "$h" true false)" ] || fail "context printed when off in project"
[ "$(agents)" = "$block" ] || fail "project override removed AGENTS.md block"

# No Codex: nothing created, Claude context still printed.
h=$(mktemp -d)
run "$h" | grep -q additionalContext || fail "context without codex"
[ ! -e "$h/.codex" ] || fail "created ~/.codex"

echo "ok"
