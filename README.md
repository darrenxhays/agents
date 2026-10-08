# agents

Plugins and skills for Claude Code and Codex.

## Skills (darrenxhays plugin)

All skills ship in one Claude Code plugin, so they're named `darrenxhays:<skill>`. Install, at a Claude Code prompt:

```
/plugin install darrenxhays --marketplace darrenxhays/agents
```

Turn on auto-update for the `agents` marketplace in `/plugin` to get every pushed change.

**Codex:** if `~/.codex` exists, each Claude session links the Codex-compatible skills into `~/.codex/skills`, pointing at Claude's installed copy, so both agents share one copy. After uninstalling, remove the link: `rm ~/.codex/skills/pragmatic-engineer`. Codex without Claude: clone the repo and link the skill yourself:

```
git clone https://github.com/darrenxhays/agents.git ~/agents
ln -s ~/agents/skills/pragmatic-engineer ~/.codex/skills/pragmatic-engineer
```

### pragmatic-engineer

Used automatically for planning and coding tasks: understand the problem, then make the smallest correct change, reusing what already exists before writing anything new. Claude Code and Codex.

### build

`/darrenxhays:build <request | path/to/request.md | Jira link>`: plan in Claude, implement with Codex, review, one fix pass, left uncommitted. Claude Code only, since it drives Codex from Claude. Requires the `codex` CLI.

## Plugins

### context-cache (Claude Code)

A band above the prompt showing context usage and a prompt-cache countdown, with COMPACT, HANDOFF and USAGE buttons and an idle keep-warm.

Install, at a Claude Code prompt (no clone needed):

```
/plugin install context-cache --marketplace darrenxhays/agents
```

Answer `y` to add the marketplace, choose the user scope, then set the options. To update later: `claude plugin update context-cache`, then `/reload-plugins`.
