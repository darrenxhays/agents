#!/bin/sh
# Self-check for session-start.sh against throwaway home directories: sh hooks/session-start.test.sh
set -e
hook="$(cd "$(dirname "$0")" && pwd)/session-start.sh"
root="$(cd "$(dirname "$0")/.." && pwd)"
rule="For any planning or coding task, use the pragmatic-engineer skill."
fail() { echo "FAIL: $1"; exit 1; }
# Optional second argument: the auto_use plugin option (unset = never configured);
# third: the project's PRAGMATIC_ENGINEER_AUTO_USE override.
run() { HOME="$1" CLAUDE_PLUGIN_ROOT="$root" CLAUDE_PLUGIN_OPTION_AUTO_USE="$2" PRAGMATIC_ENGINEER_AUTO_USE="$3" sh "$hook"; }

# Fresh Codex install: link created, rule written once, Claude context printed.
h=$(mktemp -d); mkdir "$h/.codex"
out=$(run "$h")
[ "$(readlink "$h/.codex/skills/pragmatic-engineer")" = "$root/skills/pragmatic-engineer" ] || fail "link"
[ "$(cat "$h/.codex/AGENTS.md")" = "$rule" ] || fail "rule on fresh file"
echo "$out" | grep -q '"additionalContext":"For any planning or coding task, use the darrenxhays:pragmatic-engineer skill."' || fail "context"
run "$h" >/dev/null
[ "$(grep -cxF "$rule" "$h/.codex/AGENTS.md")" = 1 ] || fail "rule duplicated on rerun"

# Existing AGENTS.md without a trailing newline keeps its last line intact.
h=$(mktemp -d); mkdir "$h/.codex"; printf 'Be terse.' > "$h/.codex/AGENTS.md"
run "$h" >/dev/null
[ "$(sed -n 1p "$h/.codex/AGENTS.md")" = "Be terse." ] && [ "$(sed -n 2p "$h/.codex/AGENTS.md")" = "$rule" ] || fail "appended onto last line"

# A real skill directory is never replaced.
h=$(mktemp -d); mkdir -p "$h/.codex/skills/pragmatic-engineer"
run "$h" >/dev/null
[ -d "$h/.codex/skills/pragmatic-engineer" ] && [ ! -L "$h/.codex/skills/pragmatic-engineer" ] || fail "replaced real dir"

# Off: rule removed from AGENTS.md (other lines kept), skill still linked, no Claude context.
h=$(mktemp -d); mkdir "$h/.codex"; printf 'Be terse.\n%s\nUse tabs.\n' "$rule" > "$h/.codex/AGENTS.md"
[ -z "$(run "$h" false)" ] || fail "context printed when off"
[ "$(cat "$h/.codex/AGENTS.md")" = "$(printf 'Be terse.\nUse tabs.')" ] || fail "rule not removed"
[ -L "$h/.codex/skills/pragmatic-engineer" ] || fail "link removed when off"

# Off when AGENTS.md is only the rule leaves an empty file.
h=$(mktemp -d); mkdir "$h/.codex"; echo "$rule" > "$h/.codex/AGENTS.md"
run "$h" false >/dev/null
[ ! -s "$h/.codex/AGENTS.md" ] || fail "rule-only file not emptied"

# On again: rule restored, Claude context printed.
run "$h" true | grep -q additionalContext || fail "context when on"
[ "$(cat "$h/.codex/AGENTS.md")" = "$rule" ] || fail "rule not restored"

# Off globally, on in this project: Claude context printed, Codex rule still removed.
h=$(mktemp -d); mkdir "$h/.codex"; echo "$rule" > "$h/.codex/AGENTS.md"
run "$h" false true | grep -q additionalContext || fail "context when on in project"
[ ! -s "$h/.codex/AGENTS.md" ] || fail "project override reached AGENTS.md"

# On globally, off in this project: no Claude context, Codex rule kept.
h=$(mktemp -d); mkdir "$h/.codex"
[ -z "$(run "$h" true false)" ] || fail "context printed when off in project"
[ "$(cat "$h/.codex/AGENTS.md")" = "$rule" ] || fail "project override removed AGENTS.md rule"

# No Codex: nothing created, Claude context still printed.
h=$(mktemp -d)
run "$h" | grep -q additionalContext || fail "context without codex"
[ ! -e "$h/.codex" ] || fail "created ~/.codex"

echo "ok"
