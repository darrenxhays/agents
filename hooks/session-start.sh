#!/bin/sh
# Runs at each Claude session start.
# Codex: link this plugin's Codex-compatible skills into ~/.codex/skills, so Codex
# reads the same copy Claude has (re-run each session because plugin updates move
# the install path; build is left out: it drives Codex from Claude), and make sure
# ~/.codex/AGENTS.md tells Codex when to use pragmatic-engineer.
# Claude: inject the same rule into the session instead of editing CLAUDE.md, so
# it goes away when the plugin is disabled or uninstalled.
rule="For any planning or coding task, use the pragmatic-engineer skill."

if [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/skills"
  for skill in pragmatic-engineer; do
    target="$HOME/.codex/skills/$skill"
    # Never replace a real directory someone put there.
    if [ -L "$target" ] || [ ! -e "$target" ]; then
      ln -sfn "$CLAUDE_PLUGIN_ROOT/skills/$skill" "$target"
    fi
  done

  agents="$HOME/.codex/AGENTS.md"
  if ! grep -qxF "$rule" "$agents" 2>/dev/null; then
    # Start on a new line if the file doesn't end with one.
    [ -s "$agents" ] && [ -n "$(tail -c1 "$agents")" ] && echo >> "$agents"
    echo "$rule" >> "$agents"
  fi
fi

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
  "For any planning or coding task, use the darrenxhays:pragmatic-engineer skill."
exit 0
