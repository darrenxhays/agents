# Prowl update notes

Shown in Prowl on the first launch after an update. Newest first: one `## x.y.z` section per release, with a `- ` line per change, written for the people using Prowl.

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
