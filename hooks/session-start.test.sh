#!/bin/sh
# Self-check for session-start.sh against throwaway home directories: sh hooks/session-start.test.sh
set -e
hook="$(cd "$(dirname "$0")" && pwd)/session-start.sh"
root="$(cd "$(dirname "$0")/.." && pwd)"
rule="For any planning or coding task, use the pragmatic-engineer skill."
fail() { echo "FAIL: $1"; exit 1; }
run() { HOME="$1" CLAUDE_PLUGIN_ROOT="$root" sh "$hook"; }

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

# No Codex: nothing created, Claude context still printed.
h=$(mktemp -d)
run "$h" | grep -q additionalContext || fail "context without codex"
[ ! -e "$h/.codex" ] || fail "created ~/.codex"

echo "ok"
