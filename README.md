# agents

Claude Code plugins and skills.

## context-cache (plugin)

A band above the prompt showing context usage and a prompt-cache countdown, with COMPACT, HANDOFF and USAGE buttons and an idle keep-warm.

Install, at a Claude Code prompt:

```
/plugin install context-cache --marketplace darrenxhays/agents
```

Answer `y` to add the marketplace, choose the user scope, then set the options. To update later: `claude plugin update context-cache`, then `/reload-plugins`.

## build (skill)

`/build <request | path/to/request.md | Jira link>`: plan in Claude, implement with Codex, review, one fix pass, left uncommitted.

Install by linking it into your personal skills:

```
ln -s ~/projects/agents/skills/build ~/.claude/skills/build
```

Requires the `codex` CLI.

## pragmatic-engineer (skill)

Loaded automatically for planning and coding tasks: understand the problem, then make the smallest correct change, reusing what already exists before writing anything new.

Install by linking it into your personal skills:

```
ln -s ~/projects/agents/skills/pragmatic-engineer ~/.claude/skills/pragmatic-engineer
```
