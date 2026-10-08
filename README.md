# agents

Plugins and skills for Claude Code and Codex.

## Skills (darrenxhays plugin)

All skills ship in one Claude Code plugin, so they're named `darrenxhays:<skill>`. Install, at a Claude Code prompt:

```
/plugin install darrenxhays --marketplace darrenxhays/agents
```

Turn on auto-update for the `agents` marketplace in `/plugin` to get every pushed change.

Each Claude session tells the agent to use pragmatic-engineer for every planning and coding task. Your `CLAUDE.md` is not edited, so the rule goes away when the plugin is disabled or uninstalled.

**Codex:** if `~/.codex` exists, each Claude session also links the Codex-compatible skills into `~/.codex/skills`, pointing at Claude's installed copy so both agents share one copy, and adds the same rule to `~/.codex/AGENTS.md` if it's missing. After uninstalling, remove both: `rm ~/.codex/skills/pragmatic-engineer` and the pragmatic-engineer line in `~/.codex/AGENTS.md`. Codex without Claude: clone the repo, link the skill and add the rule yourself:

```
git clone https://github.com/darrenxhays/agents.git ~/agents
ln -s ~/agents/skills/pragmatic-engineer ~/.codex/skills/pragmatic-engineer
echo "For any planning or coding task, use the pragmatic-engineer skill." >> ~/.codex/AGENTS.md
```

### pragmatic-engineer

Used automatically for planning and coding tasks: understand the problem, then make the smallest correct change, reusing what already exists before writing anything new. Claude Code and Codex.

### build

`/darrenxhays:build <request | path/to/request.md | ticket link>`: ticket to PR. Takes a link from Jira, Azure DevOps, GitHub, or any board the session can reach. Claude creates a branch and writes a plan to `zz/` for you to review and approve, then splits the work into subtasks built in parallel, reviews them, runs one fix pass, and asks before committing, pushing, and opening a PR. Each subtask gets the latest model and the reasoning effort its complexity needs. Subtasks run on Codex when the `codex` CLI is installed, otherwise on Claude subagents. `zz/` is ignored through `.git/info/exclude` and never committed. Claude Code only.

## Plugins

### context-cache (Claude Code)

A band above the prompt showing context usage and a prompt-cache countdown, with COMPACT, HANDOFF and USAGE buttons and an idle keep-warm.

Install, at a Claude Code prompt (no clone needed):

```
/plugin install context-cache --marketplace darrenxhays/agents
```

Answer `y` to add the marketplace, choose the user scope, then set the options. To update later: `claude plugin update context-cache`, then `/reload-plugins`.
