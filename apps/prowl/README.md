# Prowl

PR + owl. A terminal app that prowls your **Azure DevOps** or **Jira** boards for tickets tagged **Ready for Review** and runs Claude Code's `prowl-review` skill on their open GitHub PRs. Hoot the owl keeps you company while it works.

## Install

In a terminal:

```sh
# macOS / Linux
sh -c "$(curl -fsSL https://raw.githubusercontent.com/darrenxhays/agents/main/apps/prowl/install.sh)"
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/darrenxhays/agents/main/apps/prowl/install.ps1 | iex
```

The installer downloads Prowl from GitHub, asks whether your tickets are in Azure DevOps or Jira, installs whatever is missing, and skips anything already installed:

| Tool | Windows | macOS | Linux |
|---|---|---|---|
| Node.js 18+ | winget | Homebrew, or a private copy from nodejs.org | private copy from nodejs.org |
| Git | winget | Apple's Command Line Tools | your package manager |
| GitHub CLI | winget | Homebrew, or the official release | the official release |
| Claude Code | Anthropic's installer | Anthropic's installer | Anthropic's installer |
| Azure CLI (Azure DevOps only) | winget | Homebrew | Microsoft's installer |

The Node.js and GitHub CLI downloads are checked against their published checksums. Prowl itself goes to `%LOCALAPPDATA%\Prowl` (Windows) or `~/.local/share/prowl`, with a `prowl` command on your PATH.

The installer then runs `prowl --setup`, which signs you in to GitHub, Azure DevOps or Jira, and Claude Code, and adds your first board. Run `prowl --setup` again any time, for example when your Jira token expires.

Options: `--task-board ado|jira` and `--no-setup`, passed after the command as `sh -c "$(curl …)" install --task-board jira`. On Windows: `& ([scriptblock]::Create((irm <url>))) -TaskBoard jira -NoSetup`. From a clone of the repo, `sh apps/prowl/install.sh` (or `apps\prowl\install.cmd`) installs that copy instead of downloading one.

## Updates

Prowl updates itself. Each launch checks GitHub for a newer release and, when there is one, runs the installer in update mode (which also installs any tool the new version needs) and restarts on the new version. If a review from an earlier launch is still running, the update waits for a launch with none running, since a running review reads the skill's files as it goes. Offline, Prowl starts the version it has. Turn this off with `autoUpdate` in the Config view.

To update by hand, quit Prowl and run the install command again. It replaces Prowl's files and skips the tools you already have; your settings, history and review config in `~/.prowl/` are kept.

## Run

```sh
prowl --dry-run   # first time: only logs what it would review
prowl
```

On Windows, use Windows Terminal. Reviews run in the **Review folder** from setup (your projects folder), so its `CLAUDE.md` is loaded.

## What it does

1. **Polls** each configured board every 5 minutes for open tickets carrying the trigger tag (a Jira label). Near-miss spellings count too: case, spacing and punctuation are ignored, and up to 2 typos are allowed (`ready-for-reveiw` matches).
2. **Finds the PRs**: open PRs in the GitHub org whose title or description mentions the ticket (`AB#123` or `PROJ-123`). A mention only in the branch name isn't found.
3. **Skips your own work**: if any of those PRs is yours, the whole ticket is left for a teammate, since `prowl-review` reviews a ticket's PRs as one set.
4. **Claims the ticket** by swapping the trigger tag for **In Review**, so two teammates never both review it. Azure DevOps rejects the second write; on Jira, the ticket's history shows whose write came first and the other copy of Prowl backs off.
5. **Reviews**: starts a background Claude Code session (Opus 5.5, xhigh effort) running `prowl-review` on the PRs. It maps how the PRs fit together, gives each PR its own reviewer, and has every finding checked by an independent verifier. Verified findings are posted from **your** GitHub account, as real APPROVE / REQUEST_CHANGES reviews signed "🦉 PR-Owl Review" (see [Review config](#review-config)). A problem a teammate or Copilot already pointed out isn't posted again: the review links to their comment instead, or replies on it when the thread was resolved with the problem still in the code.
6. **Reports**: the agent writes a markdown report to `~/.prowl/reports/` covering the issues found, what was fixed, and links to the PRs and each comment. **In Review** becomes **Reviewed**.

**Re-review**: add the trigger tag again. The next review gets the previous report as its brief. It re-checks every earlier finding (fixed, still open or no longer applicable), replies on the old comment threads instead of re-posting, and its report lists what was fixed.

**Failures**, including a session that ends without writing its report, are retried once automatically (the trigger tag is put back). After a second failure Prowl waits for someone to re-tag. **Stopping** a review removes **In Review**; re-tag the ticket to run it again.

**Hoot** sleeps until there's news. He wakes up to say when he's checking the boards, when he picks up a ticket and starts its reviews, when each PR's review is posted, when a ticket is done, and when something goes wrong (with what went wrong).

**Jira labels** can't contain spaces, so Prowl writes `In Review` as `In-Review`. **Azure DevOps tag colours** are a board setting: Board → gear icon → Cards → Tag colors → add `In Review` (yellow) and `Reviewed`.

## Keys

| Key | Action |
|---|---|
| `←` `→`, `1`–`4`, `tab` | Running · History · Config · Log |
| `↑` `↓` | Select |
| `s` | Stop the selected review (Running) |
| `enter` | Open the report (History) · edit a setting (Config) |
| `o` / `a` | Open the PRs / the ticket in the browser |
| `a` / `d` | Add / delete a board (Config) |
| `r` | Poll now |
| `p` | Pause polling (running reviews carry on) |
| `q` | Quit. Running reviews keep going and reappear on the next launch |

## Config

Settings live in `~/.prowl/config.json`. The Config view (`3`) edits the same file, and changes apply from the next poll.

| Key | Default | Meaning |
|---|---|---|
| `taskBoard` | `ado` | **Task board**: `ado` (Azure DevOps) or `jira` (Jira Cloud). Each keeps its own boards |
| `ado.org` | | `https://dev.azure.com/<your-org>`: Azure DevOps organization (signed in with `az login`; no PAT) |
| `ado.boards` | `[]` | `[{ "project": "My Project", "team": "My Team" }]`: each team's board (its area paths) |
| `jira.site` / `jira.email` | | `https://yourcompany.atlassian.net` and your Atlassian email |
| `jira.boards` | `[]` | `[{ "board": "My Team board" }]`: a board name or id |
| `tags.trigger` / `inProgress` / `done` | `Ready for Review` / `In Review` / `Reviewed` | Tags (Jira labels) read and set |
| `tagMatchMaxTypos` | `2` | Typos still treated as the trigger tag (`0` = exact; short tags get less slack) |
| `githubOwner` | | GitHub org searched for PRs (asked by `prowl --setup`) |
| `pollSeconds` | `300` | Poll interval |
| `maxConcurrentReviews` | `2` | Extra tickets stay tagged until a slot frees, so a teammate can take them |
| `workDir` | your projects folder | Where reviews run; its `CLAUDE.md` is loaded |
| `claude.model` / `effort` / `permissionMode` | `claude-opus-5-5` / `xhigh` / `auto` | Review sessions. Avoid `bypassPermissions`: reviews read text written by PR authors |
| `dryRun` | `false` | Log what would be reviewed without touching tags or starting reviews |
| `autoUpdate` | `true` | Install a newer Prowl release before launching |

**The Jira API token** is never in the config file. Create one at <https://id.atlassian.com/manage-profile/security/api-tokens> and give it to `prowl --setup` or the Config view. It is kept in the macOS Keychain, in a file encrypted with your Windows login, or in the Linux keyring (`secret-tool`). On a machine without a keyring (a server, WSL), set the `JIRA_API_TOKEN` environment variable instead.

## Review config

How each PR is reviewed and how posts are signed are set by three files in [`skills/prowl-review/config/`](skills/prowl-review/config/):

| File | Sets |
|---|---|
| `review.md` | The reviewer's stance, the severity definitions, and the verdict rules (highest severity → verdict → APPROVE / REQUEST_CHANGES / COMMENT) |
| `axis-catalog.md` | What reviewers check: the review axes and their checklists. An axis marked ALWAYS INCLUDED is in every PR's review |
| `signature.md` | The banner at the top of each review and the prefix on each comment and reply |

To change one, copy it to `~/.prowl/config/` and edit the copy. It takes over from the next review and is kept across updates; delete it to go back to the default. Keep the five severity names (Critical, High, Medium, Low, Nit): reports count them. Prowl's History view colours a verdict by its first word (BLOCK, REQUEST, APPROVE).

## Flags and files

- `--setup`: sign in and pick boards. `--dry-run`: dry run for this launch only. `--once`: a single poll without the UI. `--self-test`: checks the matching and tagging logic and changes nothing.
- Everything lives in `~/.prowl/` (override with `PROWL_HOME`): `config.json`, `state.json` (review history), `config/` (your review config overrides), `reports/`, `logs/` (each review's prompt and session log) and `poller.log`.
- Only one instance runs per user.
- `skills/prowl-review` is Prowl's batch review skill, and only Prowl uses it: each review session loads it with `--plugin-dir` as `/prowl:prowl-review`. It isn't in the plugin marketplace and is never added to your own Claude Code skills.
- Prowl's version is `version` in `.claude-plugin/plugin.json`. Raising it on `main` releases it: every installed copy updates on its next launch.
