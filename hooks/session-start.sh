#!/bin/sh
# Runs at each Claude session start.
# Codex: link this plugin's Codex-compatible skills into ~/.codex/skills, so Codex
# reads the same copy Claude has (re-run each session because plugin updates move
# the install path; build is left out: it drives Codex from Claude), and add or
# remove the ~/.codex/AGENTS.md rule telling Codex when to use pragmatic-engineer.
# Claude: inject the same rule into the session instead of editing CLAUDE.md, so
# it goes away when the plugin is disabled or uninstalled.
# The plugin's auto_use option (/plugin configure darrenxhays) turns the rule off;
# the skills stay linked and callable. Unset means on.
# PRAGMATIC_ENGINEER_AUTO_USE (true or false, from a project's settings env, as
# helm's CONFIG panel writes it to .claude/settings.local.json) overrides that
# option for Claude sessions in that project. ~/.codex/AGENTS.md is shared by
# every project, so it follows the option alone.
rule="For any planning or coding task, use the pragmatic-engineer skill."
[ "$CLAUDE_PLUGIN_OPTION_AUTO_USE" = false ] && off=1 || off=
case "$PRAGMATIC_ENGINEER_AUTO_USE" in
  true) here_off= ;;
  false) here_off=1 ;;
  *) here_off=$off ;;
esac

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
  if [ -n "$off" ]; then
    if grep -qxF "$rule" "$agents" 2>/dev/null; then
      # Rewrite in place (not mv) so a symlinked AGENTS.md stays a symlink.
      kept=$(grep -vxF "$rule" "$agents")
      if [ -n "$kept" ]; then printf '%s\n' "$kept" > "$agents"; else : > "$agents"; fi
    fi
  elif ! grep -qxF "$rule" "$agents" 2>/dev/null; then
    # Start on a new line if the file doesn't end with one.
    [ -s "$agents" ] && [ -n "$(tail -c1 "$agents")" ] && echo >> "$agents"
    echo "$rule" >> "$agents"
  fi
fi

if [ -z "$here_off" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
    "For any planning or coding task, use the darrenxhays:pragmatic-engineer skill."
fi
exit 0
