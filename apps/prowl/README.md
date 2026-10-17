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

The first time Prowl starts after an update, it shows **Update Notes**: what changed in each version since the one you last ran (from [`CHANGELOG.md`](CHANGELOG.md)), plus any change to your config. That covers config files added to your folder, defaults that changed, and new settings. Any key closes them. With `--once` they're printed instead.

To update by hand, quit Prowl and run the install command again. It replaces Prowl's files and skips the tools you already have; your settings, history and review config in `~/.prowl/` are kept.

## Run

```sh
prowl --dry-run   # first time: only logs what it would review
prowl
```

On Windows, use Windows Terminal. Reviews run in the **Projects Directory** from setup (your projects folder), so its `CLAUDE.md` is loaded. A PR's repo that isn't cloned there yet (no folder with the repo's name) is cloned into it first.

## What it does

1. **Polls** each configured board every 5 minutes for open tickets carrying the trigger tag (a Jira label). Near-miss spellings count too: case, spacing and punctuation are ignored, and up to 2 typos are allowed (`ready-for-reveiw` matches).
2. **Finds the PRs**: open PRs in the GitHub org whose title or description mentions the ticket (`AB#123` or `PROJ-123`). A mention only in the branch name isn't found.
3. **Skips your own work**: if any of those PRs is yours, the whole ticket is left for a teammate, since `prowl-review` reviews a ticket's PRs as one set. Turn on `reviewOwnPrs` (Config, **Review my own PRs**) to review them anyway: GitHub won't let you approve or request changes on your own PR, so those get a comment review that states the verdict. When it finds nothing blocking on one, History flags it "⚑ needs a teammate's approval" until someone approves it.
4. **Claims the ticket** by swapping the trigger tag for **In Review**, so two teammates never both review it. Azure DevOps rejects the second write; on Jira, the ticket's history shows whose write came first and the other copy of Prowl backs off.
5. **Reviews**: starts a background Claude Code session (Opus 5.5, xhigh effort) running `prowl-review` on the PRs. It maps how the PRs fit together, gives each PR its own reviewer, and has every finding checked by an independent verifier. Verified findings are posted from **your** GitHub account, as real APPROVE / REQUEST_CHANGES reviews signed "🦉 PR-Owl Review" (see [Review config](#review-config)). With `approvals` off, a PR with nothing blocking gets a comment instead of an approval: Prowl gives its stamp of approval and leaves the approval to a human. A problem a teammate or Copilot already pointed out isn't posted again: the review links to their comment instead, or replies on it when the thread was resolved with the problem still in the code.
6. **Reports**: the agent writes a markdown report to `~/.prowl/reports/` covering the issues found, what was fixed, and links to the PRs and each comment. **In Review** becomes **Reviewed**.

**Re-review**: add the trigger tag again. The next review gets the previous report as its brief. It re-checks every earlier finding (fixed, still open or no longer applicable), replies on the old comment threads instead of re-posting, and its report lists what was fixed. PRs the last review approved (with `approvals` off, the ones it found nothing blocking on) are left out if they have no new commits since. They are still read as context for the other PRs, but nothing is posted on them. If every PR is approved and unchanged, the ticket goes straight to **Reviewed**.

**Failures**, including a session that ends without writing its report, are retried once automatically (the trigger tag is put back), except a review stopped by a spend, turn or time cap, so a runaway review isn't paid for twice. After a second failure Prowl waits for someone to re-tag. **Stopping** a review removes **In Review**; re-tag the ticket to run it again.

**Hoot** sleeps until there's news. He wakes up to say when he's checking the boards, when he picks up a ticket and starts its reviews, when each PR's review is posted, when a ticket is done, and when something goes wrong (with what went wrong).

**Jira labels** can't contain spaces, so Prowl writes `In Review` as `In-Review`. **Azure DevOps tag colours** are a board setting: Board → gear icon → Cards → Tag colors → add `In Review` (yellow) and `Reviewed`.

## Keys

| Key | Action |
|---|---|
| `←` `→`, `1`–`5`, `tab` | Running · History · Needs you · Config · Log |
| `↑` `↓` | Select |
| `s` | Stop the selected review or fix session (Running) · skip the selected item (Needs you) |
| `enter` | Open the report or fix brief (History) · answer the selected item (Needs you) · edit a setting or open a config file (Config) |
| `w` | Watch the selected ticket for Fix my PRs, or stop watching it (History) |
| `t` | Take the selected item's ticket over: Prowl stops fixing it (Needs you) |
| `o` / `a` | Open the PRs / the ticket in the browser |
| `a` / `d` | Add / delete a board (Config) |
| `r` | Poll now |
| `p` | Pause polling (running reviews carry on) |
| `q` | Quit. Running reviews keep going and reappear on the next launch |

## Config

Settings live in `~/.prowl/config.json`. The Config view (`4`) edits the same file, and changes apply from the next poll.

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
| `workDir` | your projects folder | **Projects Directory**: where reviews run; its `CLAUDE.md` is loaded, and PR repos not cloned there are cloned first |
| `claude.model` / `effort` / `permissionMode` | `claude-opus-5-5` / `xhigh` / `auto` | Review sessions. Avoid `bypassPermissions`: reviews read text written by PR authors |
| `claude.maxBudgetUsd` / `maxTurns` | `0` / `0` | **Spend cap** (USD) and **turn cap** per review, passed to Claude Code as `--max-budget-usd` and `--max-turns`. `0` = no cap |
| `reviewTimeoutMinutes` | `0` | **Review time limit**: stops a review running longer than this, counted from its start. `0` = no limit. A review stopped by any cap fails with the cap named (e.g. "stopped: spend cap $50") and isn't retried automatically |
| `approvals` | `true` | Approve PRs with no blocking findings. Off: comment that nothing is blocking (the *No blocking issues* template in `output.md`) and leave approving to a human. Blocking findings still request changes |
| `maxReviewRounds` | `0` | **Max review rounds** per ticket. A ticket that has had this many isn't reviewed again or claimed: it keeps its trigger tag for a person to take over, and History flags it "⚑ round cap reached". `0` = no cap |
| `parkHumanOnly` | `false` | **Park human-only findings**: a re-review classifies an earlier finding that only a person can fix outside the code (creating a CI pipeline, tracker or permissions config, a product decision) as *Parked*. It gets no new comment, is listed under *Parked* in the details file, and doesn't count toward the verdict, so it can't hold a PR at REQUEST CHANGES round after round |
| `reReviewScope` | `full` | **Re-review scope**. `full`: a re-review reads each PR whole and gets the whole previous report. `delta`: it reviews only the commits since the previous review, plus that review's still-open findings, and gets only the previous report's front matter and findings. A re-review of a review from before 2.8.0 is always `full` |
| `allowMemoryWrites` | `true` | **Reviews use memory**. Off: review sessions run with Claude Code's auto-memory off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), so they don't add their outcome to the memory index that loads into your later sessions. They don't read your memory either |
| `caffeinate` | `false` | **Keep Mac awake** (macOS only): while a review runs, `caffeinate -i` keeps the Mac from idle-sleeping, which stalls a review and stretches it out. It exits with the review. Closing the lid still sleeps the Mac |
| `logRetentionDays` | `0` | **Keep logs (days)**: on launch and each poll, review logs in `logs/` older than this are deleted (never a running review's), and `poller.log` past 5 MB is renamed `poller.log.1`, replacing the older one. Reports are always kept. `0` = keep everything |
| `ticketContext` | `false` | **Ticket text in reviews**: adds the ticket's description to the review's brief (on Azure DevOps, its acceptance criteria too), trimmed to about 6 KB, so reviewers know the goal without signing in to the tracker. It is read with Prowl's own sign-in, only for a ticket about to be reviewed; if that fails, the review runs without it |
| `dryRun` | `false` | Log what would be reviewed without touching tags or starting reviews |
| `autoUpdate` | `true` | Install a newer Prowl release before launching |

### Fix my PRs

Off by default. Turn on `fix.enabled` (Config, **Fix my PRs**) and, when a review asks for changes on PRs you authored, Prowl fixes them and sends the ticket back for a re-review, until it's ready to merge or needs you. See [Fix my PRs](#fix-my-prs-1) for how a round runs. Every `fix.*` row but the switch is hidden in the Config view while it's off.

| Key | Config label | Default | Meaning |
|---|---|---|---|
| `fix.enabled` | Fix my PRs | `false` | The switch. With `reviewOwnPrs` off, your Prowl never reviews your PRs, so rounds start only on tickets you watch (`w` in History, or `prowl --watch <ticket>`) |
| `fix.from` | Fix comments from | `everyone` | Whose unresolved review threads a fix takes on: `prowl` (threads carrying Prowl's marker), `prowl+bots` (plus bots such as Copilot), `everyone` (plus people) |
| `fix.maxRounds` | Fix rounds per ticket | `3` | Fix-and-re-review rounds; then the ticket goes to Needs you. The review round cap (`maxReviewRounds`) also ends the loop |
| `fix.maxBudgetUsd` | Spend cap per fix ($) | `25` | Per fix session (`--max-budget-usd`). `0` = no cap |
| `fix.maxTurns` | Turn cap per fix | `0` | Per fix session (`--max-turns`). `0` = no cap |
| `fix.timeoutMinutes` | Fix time limit (min) | `60` | Stops a fix session running longer than this. `0` = no limit. A session stopped by any cap goes to Needs you and isn't retried |
| `fix.ticketBudgetUsd` | Spend cap per ticket ($) | `0` | Reviews plus fixes for a ticket since its loop started. `0` = no cap |
| `fix.dailyBudgetUsd` | Spend cap per day ($) | `0` | Fix sessions since local midnight. `0` = no cap. At 70% of either cap, Prowl warns once |
| `fix.waitForChecksMinutes` | Wait for CI (min) | `30` | After a push, how long to wait for the PR's required checks before re-tagging anyway. `0` = re-tag at once |
| `fix.maxChangedLines` | Max lines changed per round | `1000` | A fix changing more lines than this isn't pushed |
| `fix.protectedPaths` | Paths that need a person | `[".github/workflows/**"]` | Globs. A fix that changes one isn't pushed. Edited in `config.json`; Config shows the count |
| `fix.protectedBranches` | Branches never pushed | `["main", "master", "release/*"]` | Globs, plus each repo's default branch. Edited in `config.json` |
| `fix.maxConcurrent` | Max parallel fixes | `1` | Fix sessions at once, apart from `maxConcurrentReviews` |
| `fix.model` | Fix model | `""` | Model for fix sessions; empty uses `claude.model` |
| `fix.effort` | Fix effort | `medium` | Reasoning effort for fix sessions |
| `fix.notify` | Desktop notifications | `false` | A notification when a ticket is ready to merge or needs you (macOS, Linux with `notify-send`, Windows) |

**The Jira API token** is never in the config file. Create one at <https://id.atlassian.com/manage-profile/security/api-tokens> and give it to `prowl --setup` or the Config view. It is kept in the macOS Keychain, in a file encrypted with your Windows login, or in the Linux keyring (`secret-tool`). On a machine without a keyring (a server, WSL), set the `JIRA_API_TOKEN` environment variable instead.

## Fix my PRs

Off by default ([settings](#fix-my-prs)). With `fix.enabled` on, when a review asks for changes on PRs **you** authored, Prowl fixes them and sends the ticket back for a re-review, round after round, until it's ready to merge or needs you.

**When a round starts.** After Prowl's own review of a ticket finishes, for each of your PRs whose verdict is REQUEST CHANGES or BLOCK, or that has an unresolved review thread `fix.from` covers. With `reviewOwnPrs` off your Prowl never reviews your PRs, so watch the ticket instead: `w` on it in History, or `prowl --watch AB#123`. Then rounds also start after reviews by a teammate's Prowl, or by people. A round never starts while the ticket's review is running, and no review starts while a round is.

**A round, per PR:**

1. **Collect.** Prowl reads the review's details file (the review copies it to `reports/<review id>/`; for a review by someone else's Prowl, it is read from the PR-Owl review on GitHub), the PR's unresolved review threads, and your past answers to similar questions. Parked findings are left out.
2. **Worktree.** It clones the repo into the Projects Directory if needed, and checks out the PR's head commit in `<Projects Directory>/.prowl-worktrees/<repo>-<n>`, detached, so your own clone and branches are never touched. The worktree is reused each round and removed once the PR is merged or closed.
3. **Fix.** A Claude Code session runs the `prowl-fix` skill there with the brief, capped by `fix.maxBudgetUsd`, `fix.maxTurns` and `fix.timeoutMinutes`. It sorts each finding and thread into fix, dispute, ask you, or park (`fix.md`), fixes in severity order with tests, runs the repo's own tests, and commits once. It can't push, post on GitHub or edit outside the worktree: a hook only fix sessions load denies all of that.
4. **Check.** Prowl runs your checks from `checks.json` in the worktree. A failure gets one more fix session, briefed with the output; a second one goes to Needs you.
5. **Guard.** Before any push: the new commit sits on top of the PR's head (no rewritten history), the remote branch hasn't moved since (if it has, the round is dropped until the next review), the change is within `fix.maxChangedLines`, touches no `fix.protectedPaths`, and adds nothing that looks like a secret.
6. **Push and reply.** `git push` to the PR's branch, never forced. Then one reply on each thread the session fixed or disputed, from the *Fix reply* and *Dispute reply* templates in `output.md`. Prowl never resolves a thread: the next review resolves the ones it verifies.
7. **Wait for CI** (`fix.waitForChecksMinutes`). A failing required check gets one more fix session, briefed with the failed job's log. Then Prowl puts the trigger tag back, and the ticket is re-reviewed.

**How it ends.** History flags a ticket **⚑ ready to merge** once every PR's latest review approves it, no review thread is open and the required checks are green; merging stays with you. A new thread after that starts another round. A ticket goes to **Needs you** (tab `3`) when a fix session asks you something, hits a cap, its checks keep failing, a guard stops a push, a PR is closed or isn't yours, or `fix.maxRounds`, `maxReviewRounds` or a spend cap is reached. Answer with `enter` (type the answer, or an option's number): a question's answer resumes the same session and is kept in `answers.jsonl` for later fixes; any other item is cleared, and the next review restarts the loop. `s` skips, and `t` takes the ticket over, so Prowl stops fixing it until you watch it again.

### checks.json

Your checks before a push, in `~/.prowl/config/checks.json` (Config, **Checks before push**). Prowl creates it as `{}` the first time Fix my PRs is on and never overwrites it. Keys are repos as `owner/name`, with `*` wildcards; the first match wins, and a repo nothing matches gets no checks from Prowl (the fix session still runs the repo's own tests). Each command runs in the worktree through your shell:

```json
{
  "my-org/web": { "setup": ["npm ci"], "run": ["npm test", "npm run lint"], "timeoutMinutes": 20 },
  "my-org/*": { "run": ["make test"], "env": { "CI": "1" } }
}
```

Keep team-specific steps in your own scripts and have `checks.json` call them, so the file stays a list of commands.

## Review config

How each PR is reviewed and what Prowl posts are set by these files. Prowl keeps your copy of each in `~/.prowl/config/`, and the Config view (`4`) links to all of them, along with `config.json` (`enter` opens one):

| File | Sets |
|---|---|
| `review.md` | The reviewer's stance, the severity definitions, and the verdict rules (highest severity → verdict → APPROVE / REQUEST_CHANGES / COMMENT) |
| `review-axis-catalog.md` | What reviewers check: the review axes and their checklists. An axis marked ALWAYS INCLUDED is in every PR's review |
| `output.md` | Templates for everything posted on GitHub: the review banner, comment prefix, the short review body, the details file collapsed at its bottom (the full write-up of every finding, for a coding agent to fix from), inline comments, replies on existing threads, and the *No blocking issues* comment used when `approvals` is off. With Fix my PRs on, also the *Fix reply* and *Dispute reply* Prowl posts after a fix, and the *Fix commit message* |
| `fix.md` | Fix my PRs only: how a fix session sorts each finding and thread (fix, dispute, ask you, or park) and what it leaves alone |

Edit your copy. Changes apply from the next review. The defaults ship in [`skills/prowl-review/config/`](skills/prowl-review/config/), and on each launch Prowl compares them with your copies:

- **A missing file** is copied in. Delete a file to go back to its default.
- **A file you haven't edited** moves to the new default when an update changes it.
- **A file you have edited** is never overwritten. The Update Notes link the new default so you can merge it by hand.

Keep the five severity names (Critical, High, Medium, Low, Nit): reports count them. Prowl's History view colours a verdict by its first word (BLOCK, REQUEST, APPROVE).

## Flags and files

- `--setup`: sign in and pick boards. `--dry-run`: dry run for this launch only. `--once`: a single poll without the UI. `--self-test`: checks the matching and tagging logic and changes nothing. `--watch <ticket>`: watch a ticket for Fix my PRs (like `w` in History), then start as usual. Fix rounds move on while Prowl runs in its UI; `--once` only plans them.
- Everything lives in `~/.prowl/` (override with `PROWL_HOME`): `config.json`, `state.json` (review history; `capped` maps each ticket at the round cap, still tagged for review, to the reviews it has had, e.g. `"capped": { "AB#123": 3 }`), `config/` (your review config), `seen.json` (the last version launched, for the Update Notes), `reports/`, `logs/` (each review's prompt and session log) and `poller.log`. With Fix my PRs on, also `checks.json` in `config/`, `fixes/` (each fix session's brief folder: `brief.md`, `result.json`, any check output, the replies it posted), `answers.jsonl` (your answers to fix sessions' questions, one JSON object per line: `ts`, `ticket`, `repo`, `question`, `answer`), and in the Projects Directory, `.prowl-worktrees/`. `state.json` then also holds `fixes` (each fix: its PR, round, session, status, cost, pushed commit, replies and checks), `loops` (per ticket: `round`, `phase` (`idle`, `collecting`, `fixing`, `checking`, `pushing`, `waiting-ci`, `re-tagged`, `ready`, `needs-you` or `stopped`), `since`, `spentUsd`, `watched`, `needs`) and `needs` (the open Needs-you items).
- Only one instance runs per user.
- `skills/prowl-review` is Prowl's batch review skill, and `skills/prowl-fix` its fix skill. Only Prowl uses them: each session loads them with `--plugin-dir` as `/prowl:prowl-review` and `/prowl:prowl-fix`. They aren't in the plugin marketplace and are never added to your own Claude Code skills.
- Prowl's version is `version` in `.claude-plugin/plugin.json`. Raising it on `main` releases it: every installed copy updates on its next launch, and shows that version's `CHANGELOG.md` section as its Update Notes.
