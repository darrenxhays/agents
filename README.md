# agents

Plugins and skills for Claude Code and Codex.

## Skills

Clone the repo once, then link each skill into every agent that should use it. Each agent then reads the same files, so there's only one copy to update.

```
git clone https://github.com/darrenxhays/agents.git ~/agents
mkdir -p ~/.claude/skills ~/.codex/skills
```

To update every installed skill in every agent at once: `git -C ~/agents pull`.

If you clone somewhere other than `~/agents`, change the paths in the commands below to match.

### pragmatic-engineer

Used automatically for planning and coding tasks: understand the problem, then make the smallest correct change, reusing what already exists before writing anything new. Works in Claude Code and Codex.

```
ln -s ~/agents/skills/pragmatic-engineer ~/.claude/skills/pragmatic-engineer
ln -s ~/agents/skills/pragmatic-engineer ~/.codex/skills/pragmatic-engineer
```

### build

`/build <request | path/to/request.md | Jira link>`: plan in Claude, implement with Codex, review, one fix pass, left uncommitted. Install it in Claude Code only, because it drives Codex from Claude. Requires the `codex` CLI.

```
ln -s ~/agents/skills/build ~/.claude/skills/build
```

## Plugins

### context-cache (Claude Code)

A band above the prompt showing context usage and a prompt-cache countdown, with COMPACT, HANDOFF and USAGE buttons and an idle keep-warm.

Install, at a Claude Code prompt (no clone needed):

```
/plugin install context-cache --marketplace darrenxhays/agents
```

Answer `y` to add the marketplace, choose the user scope, then set the options. To update later: `claude plugin update context-cache`, then `/reload-plugins`.
