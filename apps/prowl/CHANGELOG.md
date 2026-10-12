# Prowl update notes

Shown in Prowl on the first launch after an update. Newest first: one `## x.y.z` section per release, with a `- ` line per change, written for the people using Prowl.

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
