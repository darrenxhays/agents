# Prowl update notes

Shown in Prowl on the first launch after an update. Newest first: one `## x.y.z` section per release, with a `- ` line per change, written for the people using Prowl.

## 2.12.0
- Prowl now has two sides, each with its own tab: the Reviewer (everything Prowl did before) and the new Builder. tab, R or B switches between them, and 1–5 and the arrows pick Running, History, Needs you, Config and Log within the side in view. r and p poll and pause the side in view; q quits both. Each tab shows whether it's on, what's running (▶) and what needs you (⚑).
- Each side has a switch, the first row of its Config: the Reviewer is on and the Builder off, so reviews run as before until you turn the Builder on. e turns the side in view on or off, at once. Off, a side claims and starts nothing new, and sessions already running finish. With both off Prowl idles, and still picks up a switch you turn on in config.json. --reviewer-only and --builder-only override the switches for one launch.
- The Builder: tag a ticket assigned to you Ready to Start and Prowl claims it (In Development), reads it and everything linked to it into ticket.md, checks out the repos it names in worktrees beside your clones, and runs a fenced Claude Code session that investigates, plans, builds with tests and commits per repo. A plan with no open questions is approved by Prowl (Approve plans set to ask makes every plan wait for you); each open question waits in Needs you. Prowl's own code then runs your checks.json and its guards, pushes (never forced, never to main, master, release/* or a default branch), opens one ready PR per repo with the ticket key in the title, links the PRs to each other, and swaps In Development for Ready for Review, which is the Reviewer's trigger. It never changes a ticket's state.
- The Builder follows its PRs through review: once a review has finished (the ticket no longer carries Ready for Review or In Review), new review feedback starts a round in a fresh session, which fixes, disputes, asks or parks each item, then Prowl pushes, replies once on each thread it fixed or disputed (it never resolves a thread), waits for CI and tags the ticket Ready for Review again. History flags READY TO MERGE once every PR is approved, has no open threads and its checks are green; merging stays with you. A ticket that already has your open, ready PRs is followed instead of built.
- prowl --work <ticket> builds a ticket without its tag, and prowl --follow <ticket>, or w in the Builder's History, follows a ticket's PRs. Keys are AB#123 (or 123) on Azure DevOps and PROJ-123 on Jira.
- The Builder has its own caps (per session, per ticket, per day, turns and time per turn), each of which stops at Needs you instead of retrying. Each turn may spend only what's left of the tightest spend cap. In Needs you, enter answers, approves or retries, s skips or ends the work and takes the tag off, and t hands the ticket back with Ready to Start, which the Builder leaves alone until someone re-tags it.
- Jira: the Builder's tags are written as hyphenated labels (Ready-to-Start, In-Development, Ready-for-Review), as the Reviewer's already are, and Config shows them as you typed them. Jira keeps acceptance criteria and repro steps in custom fields: set their ids in jira.fields.acceptanceCriteria and jira.fields.reproSteps (Builder Config, shown on Jira) for ticket.md to include them. Left empty, those sections are left out.
- Drafts: the Reviewer now treats draft PRs as if they weren't there. It reviews the ticket's other PRs, posts nothing on a draft, doesn't read it as context and doesn't name it in the Log. A ticket whose PRs are all drafts waits, tagged and unclaimed. Your own draft no longer makes a ticket "yours". Once a draft is marked ready, re-tag the ticket: a PR no earlier review covered gets a full first review, even past Max review rounds. A PR turned back into a draft keeps its earlier findings untouched.
- A review that didn't post its review now fails instead of being tagged Reviewed. GitHub records a reply on a thread as an empty review, so a review whose own post was blocked (by an auto-mode permission check, say) used to pass as done. Each review now ends with a hidden marker line; if an open PR has no review carrying it when the session ends, the run fails, names the PR and the session log, and isn't retried automatically. Reviews started before this update are checked as before.
- prowl-review now writes review.json with the Write tool and posts it with one plain gh api call, so a permission check sees exactly what is posted.
- The fence around unattended sessions is tighter: MCP tools are denied unless builder.mcpAllow names them (with none allowed, a session starts with no MCP servers at all), and every other way to push (git send-pack, subtree push, lfs push, aliases that push, changing a remote's push URL), curl and wget writes to GitHub's API (and options they'd read from a config file), shell writes to Azure DevOps or Jira, and shell writes outside the session's folders are blocked.
- Fix my PRs is removed: the Builder does its job for the PRs it opens or follows. On this first launch Prowl stopped any fix session still running without pushing anything, removed the worktrees it made, moved your fix.* settings (MCP tools included) to config.fix-backup.json, and deleted config/fix.md if you'd never edited it. Past fixes stay in the Reviewer's History, marked Fix my PRs. --watch now tells you to use --follow. The Builder's settings start from their own defaults: set them in its Config.
- Config is reorganised: each side's switch, then a Shared section (task board and boards, GitHub org, Projects Directory, poll interval, tag typo tolerance, permission mode, memory, Keep Mac awake, logs, dry run, auto-update and checks.json), then the side's own settings. Every setting keeps its key in config.json. New config file: work.md (Build rules), linked in the Builder's Config. output.md's Fix reply, Dispute reply and Fix commit message sections now serve the Builder; if you edited your copy, it's kept.
- When the Reviewer has to put a ticket's trigger tag back (it was switched off as it claimed it, or its review couldn't start) and the tracker refuses, it now retries every minute, as it already did for its other tag changes, instead of leaving the ticket In Review.
- Each line of poller.log now names its side: [reviewer], [builder], or [prowl] for both.

## 2.11.3
- When setup rejects a Jira site address, the example it shows is now a generic https://<your-site>.atlassian.net.

## 2.11.2
- Pressing q while reviews are running now asks you to press q again to quit, instead of y. n or esc still keeps Prowl open. Quitting still leaves running reviews going in the background.

## 2.11.1
- With Approve PRs on, reviews no longer add the "No blocking issues found … waiting on a human reviewer's approval" text to a PR Prowl approves. That text is only for Approve PRs off. Nothing to do.
- output.md's *No blocking issues* section now says it's for Approve PRs off only. If you edited your copy in ~/.prowl/config/, it stays as it is; the fix works either way.

## 2.11.0
- Config (4) is now in sections, each under a heading: Config files, Task board, Tags (Labels on Jira), Review sessions, Verdicts and rounds, Fix my PRs, and Prowl. Some settings moved to join their section; every setting and its value are unchanged, and there's nothing to do.

## 2.10.0
- When Prowl starts reviewing a PR, it now posts a one-line comment on it (🦉 PR-Owl is reviewing this PR, with a link to the ticket), so teammates can see a review is under way before they pick the PR up themselves. It stays on the PR after the review is posted.
- The comment is the new *Review started* section of output.md (Config, Output templates): edit its text there. If you edited your copy in ~/.prowl/config/, it stays as it is, and Prowl uses the default's *Review started* until you copy that section in.
- Jira: two copies of Prowl signed in as the same Atlassian account (on two machines, say) can no longer both claim the same ticket. Each claim briefly adds a one-off prowl-claim-… label, so the ticket's history shows whose claim came first; Prowl takes it off again straight away. Azure DevOps already rejected the second claim, and still does.

## 2.9.0
- Fix my PRs (Config, 4), off by default: reviews run just as before until you turn it on. When a review asks for changes on PRs you authored, Prowl fixes them in a worktree, runs your checks, pushes, replies on each thread it fixed or disputed, waits for CI and re-tags the ticket for a re-review, round after round, until it's ready to merge or needs you. It never force-pushes, resolves, approves or merges.
- With Review my own PRs off, Prowl doesn't review your PRs, so fix rounds start only on tickets you watch: press w on one in History, or run prowl --watch AB#123. Rounds then also follow reviews by a teammate's Prowl, or by people.
- New tab, Needs you (3): questions only you can answer, and fixes Prowl stopped (a cap, failing checks, a guard before a push). enter answers, s skips, t takes the ticket over. Config is now tab 4 and Log tab 5.
- History shows each fix under its ticket's reviews, and flags "⚑ ready to merge" once every PR is approved, has no open threads and its required checks are green.
- Fix my PRs has its own caps: per fix session (spend, turns, time), per ticket and per day, plus rounds per ticket, lines changed per round, paths that need a person and branches never pushed. Defaults: $25 and 60 minutes per fix, 3 rounds, 1,000 lines, no pushes to .github/workflows, main, master or release/*.
- Two new config files, linked in Config once Fix my PRs is on: fix.md (Fix rules) and checks.json (Checks before push: the commands Prowl runs before each push, per repo; empty until you fill it in).
- output.md gains Fix reply, Dispute reply and Fix commit message sections. If you edited your copy in ~/.prowl/config/, it stays as it is: copy those three sections from the default to pick them up. Until you do, Prowl uses the default's.

## 2.8.0
- Nine new settings in Config (3), every one off or set to how Prowl works today, so reviews run exactly as before until you turn one on.
- Spend cap per review ($), Turn cap per review and Review time limit (min). A review that hits one is stopped and shows as failed with the cap named, for example "stopped: spend cap $50". It isn't retried automatically, so a runaway review isn't paid for twice: re-tag the ticket to run it again.
- Re-review scope: set it to delta and a re-review checks only the commits since the last review, plus that review's still-open findings, and gets only the last report's findings instead of the whole report. Prompts stay small and rounds settle sooner. A re-review of a review from before this update is still a full one.
- Max review rounds: once a ticket has had that many reviews, Prowl stops reviewing it and leaves it tagged for a person to take over. History flags it "⚑ round cap reached" until the trigger tag comes off or the cap is raised.
- Park human-only findings: on a re-review, an earlier finding that only a person can fix outside the code (creating a CI pipeline, tracker or permissions config, a product decision) is parked. It isn't posted again, it's listed under Parked in the details file, and it no longer holds the PR at REQUEST CHANGES.
- This adds a Parked section to the default output.md. If you edited your copy in ~/.prowl/config/, it stays as it is: copy the *Parked* section of the default's *Details file* template to pick this up. Until you do, Prowl adds it from the default when a finding is parked.
- Reviews use memory: turn it off and review sessions run with Claude Code's auto-memory off, so they stop adding what they did to your memory files.
- Keep Mac awake (macOS only): keeps the Mac from idle-sleeping while a review runs.
- Keep logs (days): deletes review logs older than that, and rolls poller.log over once it passes 5 MB. Reports are always kept.
- Ticket text in reviews: adds the ticket's description (and, on Azure DevOps, its acceptance criteria) to the review's brief, so reviewers know the goal without trying to sign in to the tracker.

## 2.7.0
- New setting, Review my own PRs (Config, 3), off by default. Turn it on and tickets with PRs you authored are reviewed instead of left for a teammate. GitHub won't let you approve or request changes on your own PR, so those get a comment review stating the verdict; a re-review still skips the ones with nothing blocking and no new commits.
- History flags your own PRs that Prowl found nothing blocking on with "⚑ needs a teammate's approval", since you can't approve them yourself. The flag clears once someone approves the PR, or it is merged or closed.

## 2.6.0
- Reviews are shorter. The review comment is now the PR-Owl banner with the verdict, a one-line summary, and one line per finding. The full write-up (quoted code, problem, failure scenario, a concrete fix and how to check it, for each finding) is a markdown file collapsed at the bottom of the review: expand it and copy it into your coding agent to fix the PR.
- Inline comments read like a teammate's: a sentence or two on what goes wrong, then the fix. Severity, failure scenarios and verifier notes have moved to the details file. Replies on earlier threads are shortened the same way.
- This is a change to the default output.md. If you edited your copy in ~/.prowl/config/, it stays as it is: copy the new *Review body*, *Details file*, *Inline comment* and *Reply: still present* templates from the default to pick this up. Until you do, Prowl still adds the details file, using the default's template.

## 2.5.0
- With Approve PRs off, History now flags the PRs that got Prowl's stamp of approval but still need yours: "⚑ n PRs to approve" on the ticket's row, and "⚑ needs your approval" next to each PR below it. o opens them. A flag clears on the next poll after someone approves the PR on GitHub (at the commit Prowl reviewed, or at the PR's latest commit), or once it is merged or closed. Reviews from before this update are flagged by the current Approve PRs setting.

## 2.4.2
- Review bodies are easier to read: blank lines now separate the batch, goal, role, summary and each finding, and Coverage lists each axis on its own line by name (for example "Correctness & Logic") instead of by letter. This is a change to the default output.md: if you edited your copy in ~/.prowl/config/, it stays as it is, so copy the new *Review body* template from the default to pick this up.

## 2.4.1
- Setup (prowl --setup) now lists the GitHub orgs you belong to, plus your own account. Pick one by its number, or type a name. Jira can't list your sites with an API token, so setup still asks you to type the site, and now points you to start.atlassian.com, which lists them.

## 2.4.0
- Re-reviews skip PRs that Prowl already approved, as long as they have no new commits since. They are still read as context for the ticket's other PRs, but nothing is posted on them. If every PR is approved and unchanged, the ticket goes straight to Reviewed.

## 2.3.1
- axis-catalog.md is now review-axis-catalog.md. Your copy in ~/.prowl/config/ was renamed for you, edits included.

## 2.3.0
- Update Notes: after an update, Prowl shows what changed (this screen) the first time it starts.
- Approve PRs setting (Config, 3): turn it off and Prowl stops approving PRs. When it finds nothing blocking it comments that the PR has its stamp of approval and is waiting on a human reviewer's approval. Blocking findings still request changes.
- signature.md is now output.md, which templates everything Prowl posts on GitHub: the banner, the review body, inline comments, replies, and the approvals-off comment. If you had your own signature.md, its banner and comment prefix were moved into output.md.
- Your review config files now live in ~/.prowl/config/, and Config (3) links to each one: press enter on one to open it. Updates never overwrite a file you've edited. A file you haven't edited moves to the new default, and these notes tell you when a default changes.
