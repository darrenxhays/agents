/prowl:prowl-review https://github.com/o/c/pull/3

## Context from Prowl, the review poller

- Ticket: PROJ-7 "Other" (https://x.atlassian.net/browse/PROJ-7)
- This is review 1 of this ticket.
- It started automatically because the ticket was tagged for review. Nobody is watching this session: never stop to ask a question; make the reasonable call and note it in the report.
- Approvals off (Prowl's Approve PRs setting): never post an APPROVE review; see approvals-off mode in the skill.

## Report file (required, final step)

After posting, write the review report to this exact path: /r/PROJ-7-r1.md

Start it with this front matter, filled in (counts are verified findings: new plus still-open prior ones):

---
ticket: PROJ-7
review: 1
verdict: <worst PR verdict, named as in the review config>
critical: <n>
high: <n>
medium: <n>
low: <n>
nit: <n>
fixed: <prior findings verified fixed; 0 on a first review>
stillOpen: <prior findings still open; 0 on a first review>
approved: <each PR this review approved, as <PR URL>@<head sha reviewed>, space-separated on this one line: the PRs whose review event was APPROVE, or would have been with approvals off or in comment mode (the user's own PRs). Leave it blank if none>
---

Then these sections:
1. Summary: the goal of the work, the batch verdict and the merge order, in a few sentences.
2. Pull requests: a table of PR (link), title, author, verdict and posted review (link).
3. Issues found: per PR, every verified finding with severity, title, file:line, a link to its posted comment (or to the review when it is in the review body; for a point someone else raised first, a link to their comment and to the reply, if any), the problem, the failure scenario and the suggested fix.
4. What was fixed: write "First review, nothing to compare yet."
5. Still open from the previous review: write "First review."
6. Not posted: refuted, disputed and unverifiable findings, one line each with the reason.

Every link must be a full https:// URL.
