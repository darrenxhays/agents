/prowl:prowl-review https://github.com/o/a/pull/1 https://github.com/o/b/pull/2

## Context from Prowl, the review poller

- Ticket: AB#42 "Thing" (https://dev.azure.com/o/p/_workitems/edit/42)
- This is review 2 of this ticket, a RE-REVIEW.
- It started automatically because the ticket was tagged for review. Nobody is watching this session: never stop to ask a question; make the reasonable call and note it in the report.

## This is a re-review

The previous review (review 1, finished 2025-10-09 08:53 UTC) produced the report below. The ticket has been tagged for review again, so the authors believe they have addressed it. On top of the normal prowl-review steps:

1. Add every finding from the previous report to the ledger as a prior finding. Re-verify each one against the current head of its PR and classify it as Fixed (cite the commit), Still open, or No longer applicable (code removed, PR merged or closed). These go through verifiers like any other finding.
2. Do not post duplicates of prior findings. Reply on the existing comment thread instead, with the *Verified fixed* reply from the output config and then resolve the thread (`gh api graphql`, resolveReviewThread), or with its *Still open* reply. The Step 8 re-run guard treats still-open prior findings as already posted.
3. Post new inline comments only for findings that are new since the previous review.
4. Each PR's verdict counts still-open prior findings as well as new ones, and its review body's summary and details file list them too.

<previous-report>
---
ticket: AB#42
review: 1
verdict: REQUEST CHANGES
critical: 0
high: 1
medium: 1
low: 0
nit: 1
fixed: 0
stillOpen: 0
approved: https://github.com/o/a/pull/1@aaa111
---

## Summary

Adds the thing across two repos. REQUEST CHANGES: merge o/a#1 first.

## Pull requests

| PR | Title | Author | Verdict | Review |
|---|---|---|---|---|
| https://github.com/o/a/pull/1 | API | ann | APPROVE | https://github.com/o/a/pull/1#pullrequestreview-1 |
| https://github.com/o/b/pull/2 | UI | bob | REQUEST CHANGES | https://github.com/o/b/pull/2#pullrequestreview-2 |

## Issues found

### o/b#2

- F-01 [HIGH] Null user crashes the page · src/page.ts:12 · https://github.com/o/b/pull/2#discussion_r1
- F-02 [MEDIUM] Missing CI pipeline for the new package · (review body) · https://github.com/o/b/pull/2#pullrequestreview-2
- F-03 [NIT] Typo in label · src/page.ts:30 · https://github.com/o/b/pull/2#discussion_r3

## What was fixed

First review, nothing to compare yet.

## Still open from the previous review

First review.

## Not posted

- Refuted: race on save (the lock covers it).
</previous-report>

## Report file (required, final step)

After posting, write the review report to this exact path: /r/AB42-r2.md

Start it with this front matter, filled in (counts are verified findings: new plus still-open prior ones):

---
ticket: AB#42
review: 2
verdict: <worst PR verdict, named as in the review config>
critical: <n>
high: <n>
medium: <n>
low: <n>
nit: <n>
fixed: <prior findings verified fixed>
stillOpen: <prior findings still open>
approved: <each PR this review approved, as <PR URL>@<head sha reviewed>, space-separated on this one line: the PRs whose review event was APPROVE, or would have been with approvals off or in comment mode (the user's own PRs). Leave it blank if none>
---

Then these sections:
1. Summary: the goal of the work, the batch verdict and the merge order, in a few sentences.
2. Pull requests: a table of PR (link), title, author, verdict and posted review (link).
3. Issues found: per PR, every verified finding with severity, title, file:line, a link to its posted comment (or to the review when it is in the review body; for a point someone else raised first, a link to their comment and to the reply, if any), the problem, the failure scenario and the suggested fix.
4. What was fixed: every prior finding verified fixed, with the fixing commit and a link to its comment thread.
5. Still open from the previous review: each one with a link to its comment thread.
6. Not posted: refuted, disputed and unverifiable findings, one line each with the reason.

Every link must be a full https:// URL.
