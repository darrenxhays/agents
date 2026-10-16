# agents

Plugins, skills and apps for Claude Code and Codex.

## Apps

### Prowl

A terminal app that watches your Azure DevOps or Jira boards for tickets tagged **Ready for Review** and has Claude Code review their open GitHub PRs as one set, posting verified findings from your GitHub account. It updates itself on launch. See the [Prowl README](apps/prowl/README.md) for setup, configuration and the review config.

Install or update, in a terminal:

```sh
# macOS / Linux
sh -c "$(curl -fsSL https://raw.githubusercontent.com/darrenxhays/agents/main/apps/prowl/install.sh)"
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/darrenxhays/agents/main/apps/prowl/install.ps1 | iex
```

The installer adds whatever Prowl needs (Node.js, Git, the GitHub CLI, Claude Code, and the Azure CLI for Azure DevOps), then signs you in and asks for your first board. Prowl's review skill is used only by the app: it isn't a marketplace plugin and isn't added to your Claude Code skills.

## Skills (darrenxhays plugin)

All skills ship in one Claude Code plugin, so they're named `darrenxhays:<skill>`. Install, at a Claude Code prompt:

```
/plugin install darrenxhays --marketplace darrenxhays/agents
```

Turn on auto-update for the `agents` marketplace in `/plugin` to get every pushed change.

Each Claude session tells the agent to use pragmatic-engineer for every planning and coding task. Your `CLAUDE.md` is not edited, so the rule goes away when the plugin is disabled or uninstalled.

To stop that, run `/plugin configure darrenxhays` (or open the plugin in `/plugin`) and turn off **Use pragmatic-engineer automatically**; turn it back on the same way. It takes effect from the next session. While off, the rule is no longer added to Claude sessions or `~/.codex/AGENTS.md`, and you can still call `/darrenxhays:pragmatic-engineer` (or `$pragmatic-engineer` in Codex) when you want it.

**Codex:** if `~/.codex` exists, each Claude session also links the Codex-compatible skills into `~/.codex/skills`, pointing at Claude's installed copy so both agents share one copy, and adds the same rule to `~/.codex/AGENTS.md` if it's missing. After uninstalling, remove both: `rm ~/.codex/skills/pragmatic-engineer` and the pragmatic-engineer line in `~/.codex/AGENTS.md`. Codex without Claude: clone the repo, link the skill and add the rule yourself:

```
git clone https://github.com/darrenxhays/agents.git ~/agents
ln -s ~/agents/skills/pragmatic-engineer ~/.codex/skills/pragmatic-engineer
echo "For any planning or coding task, use the pragmatic-engineer skill." >> ~/.codex/AGENTS.md
```

### pragmatic-engineer

Used automatically for planning and coding tasks (unless turned off in the plugin's settings): understand the problem, then make the smallest correct change, reusing what already exists before writing anything new. Claude Code and Codex.

### build

`/darrenxhays:build <request | path/to/request.md | ticket link>`: ticket to PR. Takes a link from Jira, Azure DevOps, GitHub, or any board the session can reach. Claude creates a branch and writes a plan to the output directory (`zz/` by default) for you to review and approve, then splits the work into subtasks built in parallel, reviews them, runs one fix pass, and asks before committing, pushing, and opening a PR. For a Jira or Azure DevOps ticket, it moves the ticket to in progress once you approve the plan and to in review once the PR is open, using the statuses the ticket's workflow allows and never moving a ticket backward. Each subtask gets the latest model and the reasoning effort its complexity needs. Subtasks run on Codex when the `codex` CLI is installed, otherwise on Claude subagents. Output files stay local and are never committed; output directories inside the repository are ignored through `.git/info/exclude`. Claude Code only.

Set `BUILD_OUTPUT_DIR` before starting Claude to change the output directory, for example `BUILD_OUTPUT_DIR=.build-output claude`. You can also specify an output directory in your build request. Relative paths resolve from the repository root; absolute paths are supported. Choose a dedicated directory for plans, specs, reviews, and run reports. The same setting applies to both Codex helper scripts.

## Plugins

### helm (Claude Code)

A band above the prompt:

- **Context and cache:** a context-usage bar with a prompt-cache countdown, COMPACT, HANDOFF, USAGE and CONFIG, and an idle keep-warm that refreshes the cache, then compacts or hands off to a fresh session.
- **Next steps:** when Claude finishes a task it suggests 2-5 next steps as numbered buttons in a card in the conversation. Click one to run it, type its number in the prompt (with a note if you like), or tick several to run them together. `/next-steps` shows the last ones again, `/next-steps suggest` asks for new ones, `/next-steps on|off` turns them on or off.

CONFIG opens helm's options below the buttons to change in place. All of them, including hiding the context band itself, are also under `/plugin configure helm`.

Install, at a Claude Code prompt (no clone needed):

```
/plugin install helm --marketplace darrenxhays/agents
```

Answer `y` to add the marketplace, choose the user scope, then set the options. To update later: `claude plugin update helm`, then `/reload-plugins`.

helm replaces context-cache. If you have context-cache installed, uninstall it (`/plugin uninstall context-cache`) before installing helm, or you'll get two bands. Your context-cache options don't carry over; set them again in helm.
