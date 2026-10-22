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

Each Claude session starts with pragmatic-engineer's instructions in its context, so they apply to every planning and coding task without loading the skill. They come back after `/compact` and `/clear`. Your `CLAUDE.md` is not edited, so they go away when the plugin is disabled or uninstalled.

To stop that, run `/plugin configure darrenxhays` (or open the plugin in `/plugin`) and turn off **Use pragmatic-engineer automatically**; turn it back on the same way. It takes effect from the next session. While off, the instructions are no longer added to Claude sessions, the rule is removed from `~/.codex/AGENTS.md`, and you can still call `/darrenxhays:pragmatic-engineer` (or `$pragmatic-engineer` in Codex) when you want it.

To override it in one project, for example off everywhere but on in a few repositories, set **This project** in helm's CONFIG panel, or add `"env": { "PRAGMATIC_ENGINEER_AUTO_USE": "true" }` (or `"false"`) to that project's `.claude/settings.local.json` yourself (`.claude/settings.json` to share it with the team). It also takes effect from the next session. The override applies to Claude sessions only: `~/.codex/AGENTS.md` is shared by every project, so it follows the global switch. If your `CLAUDE.md` imports `~/.codex/AGENTS.md` (for example with `@~/.codex/AGENTS.md`), Claude also reads the Codex rule from there, so turning pragmatic-engineer off for a project doesn't stop it there. Drop that import if you use the per-project switch.

**Codex:** if `~/.codex` exists, each Claude session also links the Codex-compatible skills into `~/.codex/skills`, pointing at Claude's installed copy so both agents share one copy, and keeps a marked block in `~/.codex/AGENTS.md` with the rule `For any planning or coding task, use the pragmatic-engineer skill.` It also removes loose copies of that rule (with or without a leading `- ` or `* `), so you don't end up with duplicates. A symlinked `AGENTS.md` stays a symlink. After uninstalling, remove both: `rm ~/.codex/skills/pragmatic-engineer` and the pragmatic-engineer block in `~/.codex/AGENTS.md`. Codex without Claude: clone the repo, link the skill and add the rule yourself:

```
git clone https://github.com/darrenxhays/agents.git ~/agents
ln -s ~/agents/skills/pragmatic-engineer ~/.codex/skills/pragmatic-engineer
echo "For any planning or coding task, use the pragmatic-engineer skill." >> ~/.codex/AGENTS.md
```

### pragmatic-engineer

Used automatically for planning and coding tasks (unless turned off in the plugin's settings): understand the problem, then make the smallest correct change, reusing what already exists before writing anything new. Claude Code and Codex.

### build

`/darrenxhays:build <request | path/to/request.md | ticket link>`: ticket to PR. Takes a link from Jira, Azure DevOps, GitHub, or any board the session can reach. Claude Code only.

1. Claude creates a branch named the way your repository names them (from recent merged PRs, remote branches, or git-flow config; `<ticket-id>-<slug>` when there's no convention) and prepares the output directory.
2. It writes one plan for you to approve. The plan lists the **decisions that need your sign-off**, anything that crosses a boundary such as permissions, billing or usage, a public API, stored data, or infrastructure, including choices the ticket itself made, so you confirm them before any code exists. Nothing is built until you approve.
3. Codex implements the plan when the `codex` CLI is installed; otherwise Claude does. Each Codex run gets a current model from the Codex catalog and the lowest reasoning effort that fits.
4. Claude runs the project's checks, and a fresh-context reviewer checks the diff against your original request. One fix pass runs only when the review asks for changes.
5. Claude asks before committing, pushing, and opening a PR against the branch your PRs usually target.

For a Jira or Azure DevOps ticket, it moves the ticket to in progress once you approve the plan and to in review once the PR is open, using the statuses the ticket's workflow allows and never moving a ticket backward.

Output files stay local and are never committed; an output directory inside the repository is ignored through `.git/info/exclude`. Each run's files share a run id (`YYYYMMDD-HHMMSS`):

```
zz/
  plans/<run-id>-<slug>.md      the plan, with its subtasks added after approval
  reviews/<run-id>-<slug>.md    the review
  runs/<run-id>-worktree.txt    staged, unstaged and untracked files before the build
  runs/<run-id>-S1-build.md     the implementer's final report (Codex)
  runs/<run-id>-fix.md          the fix pass's final report, when there is one
```

Set `BUILD_OUTPUT_DIR` before starting Claude to change the output directory, for example `BUILD_OUTPUT_DIR=.build-output claude`. You can also name an output directory in your build request. Relative paths resolve from the repository root; absolute paths are supported. Use a dedicated directory: the repository root, `.git`, or a directory with tracked files is refused.

**Checks that need a network or a local service.** Codex's sandbox blocks network access, including local services such as a database or a container runtime, so the plan splits checks into ones Codex can run and ones Claude runs after it finishes. To let Codex run them too, start Claude with `BUILD_CODEX_NETWORK=true`. Codex then runs with `sandbox_workspace_write.network_access` on, which also opens the internet to it. Off by default.

### message

`/darrenxhays:message <what the message is about>`, or used automatically: when you ask for a Teams or Slack message, a reply, a status update or anything else to send, or when Claude is about to hand you a message to send, Claude writes it with this skill instead of printing it in the reply. Claude Code on macOS only.

Claude writes a short message that leads with the point, with real links and no greeting, and puts it on your clipboard as rich text with a plain-text fallback. One paste works in both Teams and Slack, because the message uses only formatting both apps render the same way (bold, italic, strikethrough, code, links and lists), Unicode emoji instead of `:shortcodes:`, and no Slack-only syntax. Type @-mentions and channel pings yourself after pasting. Nothing is posted for you.

Claude's reply links a preview page with a **Copy** button for copying the message again. Preview pages go to `~/.claude/messages/`, and only the latest is kept: each new message deletes the previous page.

To stop Claude using it on its own, turn off **Use message automatically** in helm's CONFIG panel or in `/plugin configure darrenxhays`. It takes effect from the next session. While off, messages Claude writes stay in its reply, and `/darrenxhays:message` still works.

## Plugins

### helm (Claude Code)

A band above the prompt:

- **Context and cache:** a context-usage bar with a prompt-cache countdown, COMPACT, HANDOFF, USAGE and CONFIG, and an idle keep-warm that refreshes the cache, then compacts or hands off to a fresh session.
- **Next steps:** when Claude finishes a task it suggests 2-5 next steps as numbered buttons in a card in the conversation. Click one to run it, type its number in the prompt (with a note if you like), or tick several to run them together. `/next-steps` shows the last ones again, `/next-steps suggest` asks for new ones, `/next-steps on|off` turns them on or off.

CONFIG opens helm's options below the buttons to change in place. All of them, including hiding the context band itself, are also under `/plugin configure helm`. With the darrenxhays plugin installed, CONFIG also has **Use pragmatic-engineer automatically**: a switch for all projects, and **This project** (default, on or off) to override it here (see [Skills](#skills-darrenxhays-plugin)); and **Use message automatically**, a switch for all projects (see [message](#message)).

Install, at a Claude Code prompt (no clone needed):

```
/plugin install helm --marketplace darrenxhays/agents
```

Answer `y` to add the marketplace, choose the user scope, then set the options. To update later: `claude plugin update helm`, then `/reload-plugins`.

helm replaces context-cache. If you have context-cache installed, uninstall it (`/plugin uninstall context-cache`) before installing helm, or you'll get two bands. Your context-cache options don't carry over; set them again in helm.
