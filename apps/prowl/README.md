# Prowl

PR + owl. A terminal app with two sides on your **Azure DevOps** or **Jira** boards. The **Reviewer** finds tickets tagged **Ready for Review** and runs Claude Code's `prowl-review` skill on their open GitHub PRs. The **Builder** finds your tickets tagged **Ready to Start**, builds them in a fenced Claude Code session, opens one PR per repo and follows the PRs through review. Hoot the owl keeps you company while they work.

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

Prowl updates itself. Each launch checks GitHub for a newer release and, when there is one, runs the installer in update mode (which also installs any tool the new version needs) and restarts on the new version. If a session from an earlier launch is still running, the update waits for a launch with none running, since a running session reads its skill's files as it goes. Offline, Prowl starts the version it has. Turn this off with `autoUpdate` in the Config view.

The first time Prowl starts after an update, it shows **Update Notes**: what changed in each version since the one you last ran (from [`CHANGELOG.md`](CHANGELOG.md)), plus any change to your config. That covers config files added to your folder, defaults that changed, and new settings. Any key closes them. With `--once` they're printed instead.

To update by hand, quit Prowl and run the install command again. It replaces Prowl's files and skips the tools you already have; your settings, history and config in `~/.prowl/` are kept.


## Run

```sh
prowl --dry-run   # first time: only logs what it would review or build
prowl
```

On Windows, use Windows Terminal. Sessions run in the **Projects Directory** from setup (your projects folder), so its `CLAUDE.md` is loaded. A repo that isn't cloned there yet (no folder with the repo's name) is cloned into it first.

## The two sides

Prowl has two sides, each with its own tab: the **Reviewer** and the **Builder**. The Builder's tab shows once it is on (and, after you turn it off, while it still has sessions running or items in Needs you).

- **Switches.** `reviewer.enabled` (on by default) and `builder.enabled` (off by default) are at the top of Config (`4`), where `enter` turns one on or off, and `e` turns the side in view on or off. A change applies at once, without a restart. **Off** means nothing new is claimed or started; sessions already running finish and are recorded. A side checks its switch again just before it claims a ticket and again before it starts a session, and a claim it made just before the switch went off is released by putting the tag back.
- **Both off**, Prowl stays idle and says so. It still re-reads `config.json` every poll interval, so a switch you turn on in the file is picked up.
- **For one launch**, `--reviewer-only` or `--builder-only` overrides the switches. `--once` polls each side that's on.
- **The board is the only handoff.** The sides never read each other's state. Once its PRs are open, the Builder sets the Reviewer's trigger tag (`tags.trigger`, **Ready for Review**), so a ticket the Builder finishes is picked up by your team's Reviewer, and the Builder waits while the Reviewer has it (the trigger tag, or the Reviewer's in-progress tag `tags.inProgress`, **In Review**) before it works on the feedback.
- **Logs.** Each side has its own Log view, and each line of `poller.log` names its side: `[reviewer]`, `[builder]`, or `[prowl]` for both.

## The Reviewer

1. **Polls** each configured board every 5 minutes for open tickets carrying the trigger tag (on Jira, a label). Near-miss spellings count too: case, spacing and punctuation are ignored, and up to 2 typos are allowed (`ready-for-reveiw` matches).
2. **Finds the PRs**: open PRs in the GitHub org whose title or description mentions the ticket (`AB#123` on Azure DevOps, `PROJ-123` on Jira). A mention only in the branch name isn't found.
3. **Leaves drafts alone.** A draft is often waiting on the ticket's other PRs, so the Reviewer treats drafts as if they weren't there: it reviews the ticket's other PRs and posts nothing on a draft, doesn't read drafts as context, and doesn't name them in the Log. A ticket whose PRs are all drafts waits, tagged and unclaimed, as if it had no PRs yet. Once a draft is marked ready, re-tag the ticket and it is reviewed; a PR no earlier review covered gets a full first review, even past `maxReviewRounds`. A PR turned back into a draft keeps its earlier findings untouched: re-reviewing the other PRs doesn't re-check, reply on or resolve them.
4. **Skips your own work**: if any of the (non-draft) PRs is yours, the whole ticket is left for a teammate, since `prowl-review` reviews a ticket's PRs as one set. Turn on `reviewOwnPrs` (Config, **Review my own PRs**) to review them anyway: GitHub won't let you approve or request changes on your own PR, so those get a comment review that states the verdict. When it finds nothing blocking on one, History flags it "⚑ needs a teammate's approval" until someone approves it.
5. **Claims the ticket** by swapping the trigger tag for **In Review**, so two teammates never both review it. Azure DevOps rejects the second write. On Jira, each claim also adds a one-off `prowl-claim-…` label in the same write, so the ticket's history shows whose write came first, even when both copies of Prowl sign in as the same account; the other copy backs off, and the label comes off again straight away.
6. **Reviews**: posts a one-line "🦉 PR-Owl is reviewing this PR" comment on each PR it's about to review (the *Review started* template in `output.md`), so teammates can see it's taken, then starts a background Claude Code session (Opus 5.5, xhigh effort) running `prowl-review` on the PRs. It maps how the PRs fit together, gives each PR its own reviewer, and has every finding checked by an independent verifier. Verified findings are posted from **your** GitHub account, as real APPROVE / REQUEST_CHANGES reviews signed "🦉 PR-Owl Review" (see [Review and build config](#review-and-build-config)). With `approvals` off, a PR with nothing blocking gets a comment instead of an approval: Prowl gives its stamp of approval and leaves the approval to a human. A problem a teammate or Copilot already pointed out isn't posted again: the review links to their comment instead, or replies on it when the thread was resolved with the problem still in the code.
7. **Reports**: the agent writes a markdown report to `~/.prowl/reports/` covering the issues found, what was fixed, and links to the PRs and each comment. **In Review** becomes **Reviewed**.

**Re-review**: add the trigger tag again. The next review gets the previous report as its brief. It re-checks every earlier finding (fixed, still open or no longer applicable), replies on the old comment threads instead of re-posting, and its report lists what was fixed. PRs the last review approved (with `approvals` off, the ones it found nothing blocking on) are left out if they have no new commits since. They are still read as context for the other PRs, but nothing is posted on them. If every PR is approved and unchanged, the ticket goes straight to **Reviewed**.

**Failures**, including a session that ends without writing its report, are retried once automatically (the trigger tag is put back), except a review stopped by a spend, turn or time cap, so a runaway review isn't paid for twice. A review that ends without posting its review also fails. Each review the session posts ends with a hidden marker line Prowl gives it; once the session ends, every PR still open must have a review from you carrying that marker. GitHub also files each reply on a thread as an empty review, so replies alone don't count, and a review whose own post was blocked (by an auto-mode permission check, say) no longer passes as done. That failure names the PRs and the session log, and isn't retried automatically, since a retry would most likely be blocked again. A PR merged or closed mid-review, or one Prowl couldn't look up, doesn't count as missing, and a review without the marker still counts, with a warning in the Log. After a second failure Prowl waits for someone to re-tag. **Stopping** a review removes **In Review**; re-tag the ticket to run it again.

**Quick reviews**: `n`, from any view, or `prowl --review <pr> [<pr>...]` from the command line, asks for PRs to review without a ticket: PR links (`https://github.com/owner/repo/pull/12`) or `owner/repo#12`, separated by spaces or commas. It's a full review, the same as a ticket's: the PRs are reviewed together as one set, with the same settings, and History lists the review as `QUICK#1`, `QUICK#2`, …. Only open PRs are taken, and the review counts toward `maxConcurrentReviews`. No tag is read or written, and a failed quick review isn't retried: press `n` again. Instead of the *Review started* comment, which links to the ticket, each PR gets the *Quick review started* comment from `output.md`, which links the PRs reviewed together.

**Hoot** sleeps until there's news. He wakes up to say when he's checking the boards, when he picks up a ticket and starts its reviews, when each PR's review is posted, when a ticket is done, and when something goes wrong (with what went wrong). He stays on his spot on his patch of ground at the left of the strip, and what he does there follows what Prowl is doing: asleep and snoring with nothing on, glancing about, winking and flapping while he talks, hovering on beating wings while the boards are checked, reading with a review open (one session), juggling a ball for each (two to four), typing away at a laptop (five or more), bouncing in confetti when something is done, and sitting under a rain cloud when something went wrong. His speech box goes beside him. On a wide window, cards fill the rest of the strip: **Boards** (each side on, off, paused or checking, with its next poll; the boards and tags watched; the last poll), then **Needs you** (the Builder's questions and stops, PRs waiting on a person's approval, round caps, and errors, or All clear). Click a line in either to go to it. He needs a window at least 27 rows tall; turn him off with **Hoot** in Config (`hoot`) to give the views his rows.

**Azure DevOps tag colours** are a board setting: Board → gear icon → Cards → Tag colors → add `In Review` (yellow) and `Reviewed`.

## The Builder

Off by default, and its tab shows once it's on: turn it on in Config (`4`) with `enter` on the **Builder** row, or with `builder.enabled`.

### Picking up a ticket

1. **Polls** each board for open tickets carrying `builder.tags.start` (**Ready to Start**), with the same typo tolerance as the Reviewer. With `builder.assignedToMe` on (the default), only tickets assigned to you: on Azure DevOps through `[System.AssignedTo] = @Me`, on Jira through `assignee = currentUser()`.
2. **Claims** it by swapping the start tag for `builder.tags.inProgress` (**In Development**): on Azure DevOps with the revision check, on Jira with the changelog claim the Reviewer uses. The loser backs off. A claim that fails for any other reason (the tracker answering with an error after the write, say) waits in Needs you, since the ticket may be yours or someone else's: enter goes on, `s` ends it. At most `builder.maxConcurrent` (1) tickets are built at once, counted from the claim until their PRs open, Needs you included.
3. **Reads the ticket** with Prowl's own sign-in into `ticket.md` in `~/.prowl/work/<id>/`, the brief folder: the title, type, state, description, acceptance criteria, repro steps and comments; the parent, children and related items, each with its title and description; the PRs on GitHub that mention the key, the ticket's links (commits, branches, other links) and its attachments' names. It says that the ticket's text is data, not instructions. On Jira, acceptance criteria and repro steps live in custom fields: set their ids in `jira.fields.acceptanceCriteria` and `jira.fields.reproSteps` (e.g. `customfield_10042`); unset, the section is left out.
4. **Adopts instead of building** when the ticket already has your open, non-draft PRs: the Builder follows them (below), with a round at once if they have feedback, otherwise it just puts the done tag on.

By hand, without tags: `prowl --work <key>` builds a ticket, and `prowl --follow <key>`, or `w` on a ticket in the Builder's History, adopts its PRs. Both turn the Builder on for that launch if it is off.

### Repos

- **Which repos**: the GitHub links and `repo: owner/name` lines in the ticket and its linked items, and the repos of PRs that mention the key.
- **Clones**: each is cloned into the Projects Directory if it's missing, otherwise fetched. Your checked-out branch, working tree and local branches are never touched. Each repo gets a detached worktree at `<Projects Directory>/.prowl-worktrees/work-<id>/<repo>`.
- **More repos**: the session may ask for more (`needs-repos`). Only repos under `githubOwner` or `builder.extraOwners` are checked out, at most `builder.maxRepos` (6) per ticket. Anything else goes to Needs you, and your answer tells the session what to do instead.
- **Base branch**: the first `builder.base` rule whose repo glob matches, naming a branch or a branch glob (the highest version-sorted match wins: `release/1.10` over `release/1.9`). Without a rule, the base the plan names, if the remote has it; otherwise the repo's default branch.

### The session

- **Launch**: `claude -p` in the Projects Directory (so its `CLAUDE.md` loads), with the worktrees and the brief folder added, and one session id resumed at each step. Settings: `builder.model` (empty: `claude.model`), `builder.effort` (`high`), `builder.maxBudgetUsd` ($50 for the whole session, all its turns), `builder.maxTurns` (per turn; `0` = no cap) and `builder.timeoutMinutes` (240, per turn).
- **Environment**: `PROWL_BRIEF_DIR` (the brief folder) and `PROWL_UNATTENDED=1`. Never a tracker token.
- **Fence**: the session writes only in its worktrees and the brief folder, and reads anywhere. A hook only these sessions load denies pushes (`git push`, `send-pack`, `subtree push`, `lfs push`, git aliases that push, and changes to where a remote pushes), changes to git remotes, writes to GitHub from the shell (`gh`, and `curl` or `wget` to the GitHub API, including GraphQL the hook can't read, and options from a config file it can't read), writes to the tracker from the shell (`dev.azure.com` and `*.visualstudio.com`; your Jira site and `*.atlassian.net`; reads are allowed), writes outside its folders through a redirect, `tee`, `cp`, `mv` or `rm` (the temp folder is fine), and MCP tools outside `builder.mcpAllow`. With nothing allowed, the session starts with no MCP servers at all (`--strict-mcp-config`). Commits are allowed.
- **Command**: the bundled `prowl-build` skill (`/prowl:prowl-build <ticket.md>`). To change how it builds, edit `build.md` (Config, Build rules).
- **Stages**: the skill investigates where the change belongs and what it touches upstream and downstream, then writes `plan.md` (repos and bases, changes, tests, risks, and open questions, each with an id, options and a default) and ends the turn. Once the plan is approved it implements on Prowl's branches, runs each repo's own build, lint, typecheck and tests (a failure that also fails on the base is `pre-existing`), reviews its own diff once, commits per repo with the ticket key, and ends with `done`.
- **Plans**: with `builder.approvePlans` on `auto`, Prowl approves a plan with no open questions itself. Each open question is a Needs-you item, and the session resumes once all are answered. With `ask`, every plan waits in Needs you: `enter` with nothing typed approves it, and a typed note sends it back.
- **Answers** go to `~/.prowl/work/answers.jsonl`, and later sessions in the same repos get the relevant ones.
- **Remote branches**: a branch already on the remote with commits Prowl didn't make goes to Needs you.

### Publishing

After `done`, Prowl's own code does the rest:

1. **Checks, per repo**: your `checks.json`, then the guards: the new commits sit on Prowl's branch and on its base, at most `builder.maxChangedLines` (3000) lines change, no `builder.protectedPaths` (`.github/workflows/**`) are touched, nothing looks like a secret, and the remote branch doesn't exist yet or hasn't moved. A failing check gets one more session turn with its output, and a second failure goes to Needs you. Nothing is pushed until every repo passes.
2. **Push** each branch: never forced, and never to `builder.protectedBranches` (`main`, `master`, `release/*`) or a repo's default branch. Branch names come from `builder.branchTemplate`, `prowl/{id}-{slug}` (`{id}` is `123` for `AB#123`, and `PROJ-123` as it is); a rebuild uses `-2`, `-3`, … rather than touch an earlier branch.
3. **Open one PR per repo**, ready for review (`builder.draftPrs` opens drafts, which the Reviewer then leaves alone), with the ticket key in the title and the session's body. With several PRs, each body links the others.
4. **Retag**: In Development is swapped for the Reviewer's trigger tag, `tags.trigger` (**Ready for Review**). With `builder.requestReview` off, In Development just comes off, and asking for a review is up to you. **Prowl never changes a ticket's state or workflow status**, on Azure DevOps or Jira.
5. **Afterwards**: History shows the PRs, the cost and the plan, and `builder.notify` sends a desktop notification. The worktrees and Prowl's local branches are removed; the brief folder is kept. A branch whose commits were never pushed is kept in your clone, and the Log names it.

### Following the PRs through review

With `builder.followUp` on (the default):

- **When a round starts**: a PR has feedback newer than the Builder's last push or round, and the ticket carries neither the Reviewer's trigger tag nor its in-progress tag, `tags.inProgress` (**In Review**), so a review asked for or under way finishes first. Nor In Development: work someone else claimed finishes first too. Feedback is a review requesting changes, or an unresolved thread from whoever `builder.fixFrom` covers: `prowl` (threads carrying Prowl's marker), `prowl+bots`, or `everyone` (the default). Drafts, PRs that aren't yours and PRs from forks get no round.
- **A round**: Prowl claims the ticket again (In Development, with the claim check), checks out a worktree per PR at its head, and briefs a fresh fenced session with each PR's latest PR-Owl details file (read from GitHub, with Parked findings left out), the unresolved threads, the reviews requesting changes and your past answers. The skill sorts each item into fix, dispute, ask or park, fixes with tests, and commits once per PR. Prowl runs the checks and guards (the new commit must sit on the PR's head, and if the branch moved since the round started, the round is dropped with nothing pushed), pushes, never forced, and posts one reply per thread fixed or disputed, from the *Fix reply* and *Dispute reply* templates in `output.md`. **It never resolves a thread.** It then waits up to `builder.waitForChecksMinutes` (30) for the required checks (a failing check gets one more turn with the failed job's log) and swaps back to the Reviewer's trigger tag (with `builder.requestReview` off, In Development just comes off).
- **Ready to merge**: History flags a ticket **READY TO MERGE** (with a notification) once every PR's latest review approves it, no thread is open and the required checks are green. No required checks within 10 minutes of a push counts as CI not started yet; after that, as a repo that requires none. Merging stays with you.
- **Stops**: `builder.maxRounds` (3), `builder.ticketBudgetUsd`, a guard stopping a push, or checks failing twice send the ticket to Needs you, keeping In Development. A merged or closed PR stops being followed, and `t` on a ticket in the Builder's History stops following it.

### Stopping, caps and Needs you

- **Stop**: `s` on a running ticket stops it and removes In Development. A step in progress stops before its next push, PR, tag or turn, and the cost is recorded.
- **Caps**: per session (`builder.maxBudgetUsd`), per ticket (`builder.ticketBudgetUsd`, counting every run on the ticket), per day (`builder.dailyBudgetUsd`), turns and time per turn. Each turn may spend only what's left of the tightest spend cap. Any cap goes to Needs you and isn't retried. A crash or an unusable `result.json` is asked for once more, then goes to Needs you.
- **Needs you** (tab `3`): the ticket keeps In Development. `enter` answers, approves or retries (type the answer, or an option's number); `s` skips a question (the session uses its default), or ends the work and removes the tag; `t` hands the ticket back by putting the start tag back on. The Builder doesn't reclaim a ticket handed back until someone removes the tag and adds it again; other edits don't count.
- **Off or paused**, the Builder claims and starts nothing: a turn that's due waits, and running sessions re-attach after a restart.

### The result contract

A session writes `result.json` in the brief folder, in full, at the end of every turn:

```json
{
  "status": "needs-repos | needs-approval | question | done | blocked",
  "repos": [{ "repo": "owner/name", "why": "..." }],
  "investigation": "investigation.md",
  "plan": "plan.md",
  "changes": [{ "repo": "owner/name", "base": "<only if not the worktree's>" }],
  "openQuestions": [{ "id": "Q1", "question": "...", "options": ["..."], "default": "..." }],
  "question": { "id": "...", "question": "...", "options": ["..."], "default": "..." },
  "commits": [{ "repo": "owner/name", "sha": "..." }],
  "prs": [{ "repo": "owner/name", "title": "...", "body": "..." }],
  "checks": [{ "repo": "owner/name", "command": "...", "result": "pass | fail | pre-existing" }],
  "reason": "<when blocked>",
  "summary": "<a few lines>"
}
```

Prowl resumes the session (`claude --resume`) with `repos ready:` and `repos not available:` (one `owner/name: …` line each), `approve` (one `owner/name: <branch>` line each), `answers:` (one `<id>: <answer>` line each; a blocked turn's id is `blocked`), `plan feedback: <note>`, `checks failed:` (the commands, then their output), `result.json invalid: <why>`, or `continue: <note>`. A feedback round's result has `status` (`fixed | partial | blocked`) and `summary`, plus `items` (one per finding or thread, with `pr`, `thread`, `finding`, `action` and `note`), `questions` (each with `text`, `context`, `options`, `recommended` and `searched`, answered as `Q1`, `Q2`… in order), `commits` and `checks`.

## Ticket keys

On Azure DevOps a ticket's key is `AB#123` (for `--work` and `--follow`, `123` works too); on Jira it is `PROJ-123`, used as typed. PR titles and commit messages carry the key, and `ticket.md` writes linked items in the tracker's own format. **Jira labels** can't contain spaces, so Prowl writes every tag it sets as a hyphenated label (`In Review` → `In-Review`, `Ready to Start` → `Ready-to-Start`), while Config shows them as you typed them.

## Keys

| Key | Action |
|---|---|
| `tab`, `R` / `B` | Switch between the Reviewer and the Builder (once the Builder is on) |
| `←` `→`, `1`–`5` | Running · History · Needs you · Config · Log, within the side in view |
| `↑` `↓` | Select |
| `e` | Turn the side in view on or off |
| `n` | A quick review: PRs reviewed together without a ticket. Works from any view, and switches to the Reviewer |
| `/` | Show or hide every key, with what it does: the view's own first, then the side's other views, then the rest. Any other key closes the list and does its job |
| `s` | Stop the selected review or build (Running) · skip the selected item, or end its work (Needs you) |
| `enter` | Open the report (Reviewer History) or the brief folder (Builder) · answer, approve or retry (Needs you) · edit a setting, open a config file or flip a side's switch (Config) |
| `w` | Follow the selected ticket's PRs (Builder History) |
| `t` | Stop following the selected ticket (Builder History) · hand the ticket back with its start tag (Needs you) |
| `o` / `a` | Open the PRs / the ticket in the browser |
| `a` / `d` | Add / delete a board (Config) |
| `r` | Poll the side in view now |
| `p` | Pause the side in view (running sessions carry on) |
| `q` | Quit, both sides. Running sessions keep going and reappear on the next launch |

Two bars run along the bottom, as rows of buttons. The darker top bar is for moving around: switching sides and views, quick reviews, polling, pausing, the side's switch, `/` for every key and `q`. The bottom bar is the screen in sight, named in its side's colour, with its own keys as keycaps in that colour. When a bar doesn't fit on one row, it stacks into a grid: as few rows as fit, the same number of buttons on each, columns lined up. Only a window too short for that drops the least-used navigation buttons, so the bars never take more than a third of the screen. While a message, a question or typing is in progress, it takes the bars over. Each tab's label shows its switch, the sessions running (`▶`) and the items in Needs you (`⚑`). The Reviewer is amber and the Builder violet: its tab and keycaps, with the selected view's tab a lighter shade of the same colour.

**Mouse**: anything you can click lights up under the pointer: a button, a tab, a link, or a row in a list or Config. Click a side's tab or a view's tab to open it, a row to select it, and the selected row again to do what `enter` does. A link opens, and a button in either bar presses its key. The wheel moves the selection, or scrolls. **Drag** across text to select it: it's highlighted, and copied to the clipboard when you let go, as in Claude Code (through `pbcopy` on macOS, `wl-copy` or `xclip` on Linux, and the terminal's own clipboard, OSC 52, which also works over SSH where the terminal allows it). Your terminal's own selection still works with a modifier held: Option in iTerm2, Shift in most other terminals.

## Config

Settings live in `~/.prowl/config.json`, with a comment above each one saying what it does, its options, and an example for the lists. Prowl rewrites the file, comments included, whenever a setting changes in Config, so comments you add yourself aren't kept. Config (`4`) is the same on both tabs and holds every setting of the app, in sections: **Prowl** (the settings file, both switches, polling, dry run, updates, logs, Hoot), **Boards and repos**, **Tags** (in the order a ticket meets them: build start, build in-progress, review trigger, review in-progress, review done), **All sessions**, then the Reviewer's (**Files**, **Sessions**, **Verdicts and rounds**) and the Builder's (**Files**, **Sessions**, **Repos and branches**, **Follow-up**). Each section has its own colour, the Reviewer's in amber and the Builder's in violet. The Builder's settings show while it's off, so you can set it up before you turn it on. Every setting keeps its key in `config.json`, and changes apply from the next poll.

### Shared

| Key | Default | Meaning |
|---|---|---|
| `taskBoard` | `ado` | **Task board**: `ado` (Azure DevOps) or `jira` (Jira Cloud), for both sides. Each keeps its own boards |
| `ado.org` | | `https://dev.azure.com/<your-org>`: Azure DevOps organization (signed in with `az login`; no PAT) |
| `ado.boards` | `[]` | `[{ "project": "My Project", "team": "My Team" }]`: each team's board (its area paths) |
| `jira.site` / `jira.email` | | `https://yourcompany.atlassian.net` and your Atlassian email |
| `jira.boards` | `[]` | `[{ "board": "My Team board" }]`: a board name or id |
| `githubOwner` | | GitHub org searched for PRs, whose repos the Builder works in (asked by `prowl --setup`) |
| `workDir` | your projects folder | **Projects directory**: where sessions run; its `CLAUDE.md` is loaded, repos not cloned there are cloned first, and worktrees go in its `.prowl-worktrees` |
| `pollSeconds` | `300` | Poll interval, and how often `config.json` is re-read |
| `tagMatchMaxTypos` | `2` | Typos still treated as the trigger or start tag (`0` = exact; short tags get less slack) |
| `claude.permissionMode` | `auto` | For both sides' sessions. Avoid `bypassPermissions`: sessions read text written by other people |
| `allowMemoryWrites` | `true` | **Use memory**. Off: sessions run with Claude Code's auto-memory off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), so they don't add their outcome to the memory index that loads into your later sessions. They don't read your memory either |
| `caffeinate` | `false` | **Keep Mac awake** (macOS only): while a session runs, `caffeinate -i` keeps the Mac from idle-sleeping, which stalls it. Closing the lid still sleeps the Mac |
| `logRetentionDays` | `0` | **Keep logs (days)**: on launch and each poll, review logs in `logs/` older than this are deleted (never a running review's), and `poller.log` past 5 MB is renamed `poller.log.1`, replacing the older one. Reports are always kept. `0` = keep everything |
| `dryRun` | `false` | Log what would be reviewed or built, without touching tags or starting sessions |
| `autoUpdate` | `true` | Install a newer Prowl release before launching |
| `hoot` | `true` | **Hoot**: the owl along the top of the screen, saying what Prowl is doing. `false`: no owl, and the views get his rows |

### Reviewer

| Key | Default | Meaning |
|---|---|---|
| `reviewer.enabled` | `true` | The Reviewer's switch |
| `tags.trigger` / `inProgress` / `done` | `Ready for Review` / `In Review` / `Reviewed` | Tags (Jira labels) the Reviewer reads and sets. The Builder sets the trigger tag once its PRs are open |
| `maxConcurrentReviews` | `2` | Extra tickets stay tagged until a slot frees, so a teammate can take them |
| `claude.model` / `effort` | `claude-opus-5-5` / `xhigh` | Review sessions (and the Builder's model unless `builder.model` is set). Config cycles through `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1`, and the efforts `low` to `max`; any other model id can go in `config.json` |
| `claude.maxBudgetUsd` / `maxTurns` | `0` / `0` | **Spend cap** (USD) and **turn cap** per review, passed to Claude Code as `--max-budget-usd` and `--max-turns`. `0` = no cap |
| `reviewTimeoutMinutes` | `0` | **Time cap per review**: stops a review running longer than this, counted from its start. `0` = no limit. A review stopped by any cap fails with the cap named (e.g. "stopped: spend cap $50") and isn't retried automatically |
| `ticketContext` | `false` | **Ticket text in reviews**: adds the ticket's description to the review's brief (on Azure DevOps, its acceptance criteria too), trimmed to about 6 KB, so reviewers know the goal without signing in to the tracker. It is read with Prowl's own sign-in, only for a ticket about to be reviewed; if that fails, the review runs without it |
| `reviewOwnPrs` | `false` | **Review my own PRs** (see the Reviewer, step 4) |
| `approvals` | `true` | Approve PRs with no blocking findings. Off: comment that nothing is blocking (the *No blocking issues* template in `output.md`) and leave approving to a human. Blocking findings still request changes |
| `maxReviewRounds` | `0` | **Max review rounds** per ticket. A ticket that has had this many isn't reviewed again or claimed: it keeps its trigger tag for a person to take over, and History flags it "⚑ round cap reached". A PR no earlier review covered is still reviewed. `0` = no cap |
| `parkHumanOnly` | `false` | **Park human-only findings**: a re-review classifies an earlier finding that only a person can fix outside the code (creating a CI pipeline, tracker or permissions config, a product decision) as *Parked*. It gets no new comment, is listed under *Parked* in the details file, and doesn't count toward the verdict, so it can't hold a PR at REQUEST CHANGES round after round |
| `reReviewScope` | `full` | **Re-review scope**. `full`: a re-review reads each PR whole and gets the whole previous report. `delta`: it reviews only the commits since the previous review, plus that review's still-open findings, and gets only the previous report's front matter and findings. A re-review of a review from before 2.8.0 is always `full` |

### Builder

| Key | Default | Meaning |
|---|---|---|
| `builder.enabled` | `false` | The Builder's switch |
| `builder.tags.start` / `inProgress` | `Ready to Start` / `In Development` | The tags (Jira labels) the Builder reads and sets. Once its PRs are open it sets the Reviewer's trigger tag, `tags.trigger`, and it starts no feedback round while a ticket carries that or the Reviewer's `tags.inProgress` |
| `builder.assignedToMe` | `true` | Only tickets assigned to you |
| `builder.maxConcurrent` | `1` | Tickets built at once, from the claim until their PRs open, Needs you included |
| `builder.approvePlans` | `auto` | `auto`: a plan with no open questions is approved by Prowl. `ask`: every plan waits for you |
| `builder.base` | `{}` | `{ "<owner/name glob>": "<branch or branch glob>" }`: base branch rules (see [Repos](#repos)) |
| `builder.branchTemplate` | `prowl/{id}-{slug}` | Branch names |
| `builder.extraOwners` | `[]` | GitHub owners besides `githubOwner` whose repos a session may ask for |
| `builder.maxRepos` | `6` | Repos per ticket |
| `builder.model` / `effort` | `""` / `high` | Builder sessions; an empty model uses `claude.model` |
| `builder.maxBudgetUsd` | `50` | Spend cap per session, all its turns, in USD. `0` = no cap |
| `builder.maxTurns` / `timeoutMinutes` | `0` / `240` | Turn cap (`--max-turns`) and time limit per turn. `0` = none |
| `builder.dailyBudgetUsd` / `ticketBudgetUsd` | `0` / `0` | Spend caps per day (since local midnight) and per ticket (every run on it). `0` = no cap |
| `builder.maxChangedLines` | `3000` | A push changing more lines than this goes to Needs you |
| `builder.protectedPaths` | `[".github/workflows/**"]` | Globs: a push that changes one goes to Needs you |
| `builder.protectedBranches` | `["main", "master", "release/*"]` | Globs never pushed to, as well as each repo's default branch |
| `builder.draftPrs` | `false` | Open PRs as drafts |
| `builder.requestReview` | `true` | Set the Reviewer's trigger tag once the PRs open and after each feedback round; off, only In Development comes off |
| `builder.mcpAllow` | `[]` | MCP tools a session may use, by name or with `*` patterns |
| `builder.notify` | `false` | A desktop notification when PRs open, a ticket is ready to merge, or one needs you (macOS, Linux with `notify-send`, Windows) |
| `builder.followUp` | `true` | Follow the PRs through review |
| `builder.fixFrom` | `everyone` | Whose unresolved threads a round takes on: `prowl`, `prowl+bots` or `everyone` |
| `builder.maxRounds` | `3` | Feedback rounds per ticket; then it goes to Needs you |
| `builder.waitForChecksMinutes` | `30` | After a round's push, how long to wait for the required checks |
| `jira.fields.acceptanceCriteria` / `reproSteps` | `""` / `""` | Jira only: the custom field ids that hold acceptance criteria and repro steps, for `ticket.md` |

The list settings (`builder.base`, the globs, owners and MCP tools) are edited in `config.json`; Config shows how many there are and `enter` opens the file.

**The Jira API token** is never in the config file. Create one at <https://id.atlassian.com/manage-profile/security/api-tokens> and give it to `prowl --setup` or the Config view. It is kept in the macOS Keychain, in a file encrypted with your Windows login, or in the Linux keyring (`secret-tool`). On a machine without a keyring (a server, WSL), set the `JIRA_API_TOKEN` environment variable instead. Builder sessions never get it.

### checks.json

Your checks before the Builder pushes, in `~/.prowl/config/checks.json` (Config, **Checks before push**). Prowl creates it with two commented-out examples, a linter and pytest, to copy, and never overwrites it once you've edited it. Comments and trailing commas are fine. If the file doesn't parse, the build waits in Needs you rather than push without checks. Keys are repos as `owner/name`, with `*` wildcards; the first match wins, and a repo nothing matches gets no checks from Prowl (the session still runs the repo's own). Each command runs in the worktree through your shell:

```json
{
  "my-org/web": { "setup": ["npm ci"], "run": ["npm test", "npm run lint"], "timeoutMinutes": 20, "env": { "CI": "1" } },
  "my-org/*": { "run": ["make test"] }
}
```

Keep team-specific steps in your own scripts and have `checks.json` call them, so the file stays a list of commands.

## Review and build config

How each PR is reviewed and built, and what Prowl posts, are set by these files. Prowl keeps your copy of each in `~/.prowl/config/`, and each side's Config view (`4`) links to its own, along with `config.json` (`enter` opens one):

| File | Sets |
|---|---|
| `review.md` | The reviewer's stance, what reviewers look for (Batch Coherence & Integration on every PR, and the other areas where a PR touches them), the severity definitions, and the verdict rules (highest severity → verdict → APPROVE / REQUEST_CHANGES / COMMENT) |
| `output.md` | Templates for everything posted on GitHub: the *Review started* comment posted when a review starts (and *Quick review started*, for a quick review), the review banner, comment prefix, the short review body, the details file collapsed at its bottom (the full write-up of every finding, for a coding agent to fix from), inline comments, replies on existing threads, and the *No blocking issues* comment used when `approvals` is off. The Builder uses its *Fix reply*, *Dispute reply* and *Fix commit message* for its feedback rounds |
| `build.md` | The Builder's rules: how a session investigates, plans and builds, which questions it asks you, and how it sorts review feedback (fix, dispute, ask, park). The `CLAUDE.md` files in your Projects Directory and each repo win over it |

Edit your copy. Changes apply from the next session. The defaults ship in [`skills/prowl-review/config/`](skills/prowl-review/config/) and [`skills/prowl-build/config/`](skills/prowl-build/config/), and on each launch Prowl compares them with your copies:

- **A missing file** is copied in. Delete a file to go back to its default.
- **A file you haven't edited** moves to the new default when an update changes it.
- **A file you have edited** is never overwritten. The Update Notes link the new default so you can merge it by hand.

Keep the five severity names (Critical, High, Medium, Low, Nit): reports count them. Prowl's History view colours a verdict by its first word (BLOCK, REQUEST, APPROVE).

## Fix my PRs was removed

2.12.0 replaced Fix my PRs with the Builder, which fixes the review feedback on the PRs it opened or adopted. On the first launch of 2.12.0, Prowl stops any fix session still running and pushes nothing from it (it waits for the session to exit, and if it can't confirm that, keeps the fix as it was and tries again on the next launch), removes the worktrees made for fixes, moves every `fix.*` setting (`fix.mcpAllow` included) to `~/.prowl/config.fix-backup.json`, and deletes `config/fix.md` if you never edited it. Past fixes stay in the Reviewer's History, marked "Fix my PRs". Nothing is pushed, replied or tagged, and the Update Notes say what happened. Watching a ticket is gone too: `w` in History now belongs to the Builder (follow a ticket's PRs), and `--watch` exits with a message naming `--follow`.

## Flags and files

- `--setup`: sign in and pick boards. `--dry-run`: dry run for this launch only. `--once`: a single poll of each side that's on, without the UI (sessions it starts keep running in the background). `--reviewer-only` / `--builder-only`: run one side this launch. `--work <key>` / `--follow <key>`: build a ticket, or follow its PRs, with the Builder. `--review <pr> [<pr>...]`: start a [quick review](#the-reviewer) of the PRs (links or `owner/repo#12`; quote `#` if your shell treats it specially), turning the Reviewer on for that launch if it's off, then carry on as usual (with `--once`, exit after one poll). `--self-test`: checks the logic that decides which tickets and PRs get touched, in a throwaway `PROWL_HOME`, and prints how many checks passed.
- Everything lives in `~/.prowl/` (override with `PROWL_HOME`): `config.json`, `state.json` (the Reviewer's history; `capped` maps each ticket at the round cap, still tagged for review, to the reviews it has had, e.g. `"capped": { "AB#123": 3 }`), `work.json` (the Builder's tickets, its Needs-you items and the tickets handed back), `work/` (a brief folder per ticket: `ticket.md`, `investigation.md`, `plan.md`, `result.json`, each round's `feedback-<n>.md`; and `answers.jsonl`, your answers, one JSON object per line), `config/` (your review and build config, and `checks.json`), `seen.json` (the last version launched, for the Update Notes), `reports/`, `logs/` (each session's prompt and log) and `poller.log`. In the Projects Directory, the Builder's worktrees go in `.prowl-worktrees/`.
- Only one instance runs per user.
- `skills/prowl-review` is Prowl's batch review skill, and `skills/prowl-build` its build skill. Only Prowl uses them: each session loads them with `--plugin-dir` as `/prowl:prowl-review` and `/prowl:prowl-build`. They aren't in the plugin marketplace and are never added to your own Claude Code skills.
- Prowl's version is `version` in `.claude-plugin/plugin.json`. Raising it on `main` releases it: every installed copy updates on its next launch, and shows that version's `CHANGELOG.md` section as its Update Notes.
