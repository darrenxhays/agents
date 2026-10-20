#!/bin/sh
# Runs when a Claude session starts, is cleared, or is compacted (not on resume:
# the transcript already holds the context).
# Codex: link this plugin's Codex-compatible skills into ~/.codex/skills, so Codex
# reads the same copy Claude has (re-run each session because plugin updates move
# the install path; build is left out: it drives Codex from Claude), and keep a
# marked block in ~/.codex/AGENTS.md telling Codex when to use pragmatic-engineer.
# Claude: inject pragmatic-engineer's instructions into the session instead of
# editing CLAUDE.md, so they go away when the plugin is disabled or uninstalled.
# The plugin's auto_use option (/plugin configure darrenxhays) turns both off;
# the skills stay linked and callable. Unset means on.
# PRAGMATIC_ENGINEER_AUTO_USE (true or false, from a project's settings env, as
# helm's CONFIG panel writes it to .claude/settings.local.json) overrides that
# option for Claude sessions in that project. ~/.codex/AGENTS.md is shared by
# every project, so it follows the option alone.
rule="For any planning or coding task, use the pragmatic-engineer skill."
begin="<!-- BEGIN pragmatic-engineer (managed by the darrenxhays plugin) -->"
end="<!-- END pragmatic-engineer -->"
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
  if [ -e "$agents" ] || [ -z "$off" ]; then
    current=$(cat "$agents" 2>/dev/null)
    # Drop loose copies of the rule (bulleted or not), and keep the block in place
    # when on or drop it when off. A begin marker without an end keeps what follows.
    # Exits 3 when the block is wanted but wasn't there.
    kept=$(printf '%s\n' "$current" | awk -v rule="$rule" -v begin="$begin" -v end="$end" -v off="$off" '
      function loose(line) { sub(/^[-*] /, "", line); sub(/[ \t]+$/, "", line); return line == rule }
      $0 == begin && !inblock { inblock = 1; held = ""; next }
      inblock && $0 == end {
        inblock = 0
        if (!off && !done) { print begin; print rule; print end; done = 1 }
        next
      }
      inblock { held = held $0 "\n"; next }
      loose($0) { next }
      { print }
      END {
        if (inblock) { n = split(held, rest, "\n"); for (i = 1; i < n; i++) if (!loose(rest[i])) print rest[i] }
        exit (!off && !done) ? 3 : 0
      }')
    if [ $? = 3 ]; then
      # Append the block, after a blank line when the file has content.
      [ -n "$kept" ] && kept="$kept

"
      kept="$kept$begin
$rule
$end"
    fi
    if [ "$kept" != "$current" ]; then
      # Rewrite in place (not mv) so a symlinked AGENTS.md stays a symlink.
      if [ -n "$kept" ]; then printf '%s\n' "$kept" > "$agents"; else : > "$agents"; fi
    fi
  fi
fi

if [ -z "$here_off" ]; then
  # The skill's body without its frontmatter, as one JSON string.
  body=$(awk 'NR == 1 && $0 == "---" { fm = 1; next } fm && $0 == "---" { fm = 0; next } !fm' \
    "$CLAUDE_PLUGIN_ROOT/skills/pragmatic-engineer/SKILL.md" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' \
    | awk 'NF || started { started = 1; printf "%s%s", sep, $0; sep = "\\n" }')
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
    "For any planning or coding task, follow this approach (the darrenxhays:pragmatic-engineer skill; no need to load it):\\n\\n$body"
fi
exit 0
