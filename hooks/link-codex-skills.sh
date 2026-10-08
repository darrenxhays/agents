#!/bin/sh
# Link this plugin's Codex-compatible skills into ~/.codex/skills, so Codex reads
# the same copy Claude has. Re-run each session because plugin updates move the
# install path. build is left out: it drives Codex from Claude.
[ -d "$HOME/.codex" ] || exit 0
mkdir -p "$HOME/.codex/skills"
for skill in pragmatic-engineer; do
  target="$HOME/.codex/skills/$skill"
  # Never replace a real directory someone put there.
  if [ -L "$target" ] || [ ! -e "$target" ]; then
    ln -sfn "$CLAUDE_PLUGIN_ROOT/skills/$skill" "$target"
  fi
done
exit 0
