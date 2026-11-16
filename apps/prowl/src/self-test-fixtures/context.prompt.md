/prowl:prowl-review https://github.com/o/b/pull/2 https://github.com/o/a/pull/1

## Context from Prowl, the review poller

- Ticket: AB#42 "Thing" (https://dev.azure.com/o/p/_workitems/edit/42)
- This is review 2 of this ticket, a RE-REVIEW.
- It started automatically because the ticket was tagged for review. Nobody is watching this session: never stop to ask a question; make the reasonable call and say so in the closing message.
- Every review, first or not, re-checks each open PR-Owl thread on the PRs it reviews, whoever's Prowl raised it (the skill's Step 2), and gives each one its status in the review result (the skill's Step 8).
- The batch id: `rb-20260101-ab42-r2-0900-ab12`.
- The result path: /r/AB42-r2.result.json
- The checker command: `"/usr/bin/node" "/app/prowl.mjs" --check-result "/r/AB42-r2.result.json" --batch rb-20260101-ab42-r2-0900-ab12 --prs "https://github.com/o/b/pull/2,https://github.com/o/a/pull/1"`

## Unchanged since the last review: context only

An earlier review cleared these PRs and they have no new commits since. Prowl leaves them out of this review (see Step 1): read them for the batch brief and the cross-PR contracts, but give them no spec or reviewer. The previous review has no result to copy from, so these PRs' earlier findings are not carried: leave them out of the result, and a later review reads them from the PR.

- https://github.com/o/a/pull/1

## This is a re-review

The previous review (review 1, finished 2025-10-09 08:53 UTC) found what is below. The ticket has been tagged for review again, so the authors believe they have addressed it. On top of the normal prowl-review steps:

1. Use the previous review's findings in Prowl's context (below) as the record for the prior findings read from the PRs' open PR-Owl threads (the skill's Step 5): match each to its thread by its link, or by its batch id and id, for the full problem and fix. One with no open thread (raised only in a review body, or its thread resolved since) is still added to the ledger as a prior finding. Re-verify every prior finding against the current head of its PR: they go through verifiers like any other finding.
2. A new finding about the same defect as a prior finding is that prior finding: keep the prior entry, so the result ties it to its existing thread. Except a `deferred` one (on a PR left out of this review): a new finding on a reviewed PR that matches it stays its own finding on the reviewed PR, with `crossPr.fixBelongsTo` naming the left-out PR, and the deferred copy stays as it is.
3. Each prior finding gets its status in the result (the skill's Step 8, *Statuses*), with its `earlier` filled from the PR as it is now (starting from the one given below). `threadState` is always the thread's state now, never the one given. Every prior finding given below comes back in the result, under its `ref` as `earlier.ref`. Only one on a PR left out of this review goes in as `deferred`; one on a PR this review covers is never `deferred`, and Prowl treats a PR missing one as not fully reviewed.

<previous-findings>
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

## Issues found

### o/b#2

- F-01 [HIGH] Null user crashes the page · src/page.ts:12 · https://github.com/o/b/pull/2#discussion_r1
- F-02 [MEDIUM] Missing CI pipeline for the new package · (review body) · https://github.com/o/b/pull/2#pullrequestreview-2
- F-03 [NIT] Typo in label · src/page.ts:30 · https://github.com/o/b/pull/2#discussion_r3

## Still open from the previous review

First review.
</previous-findings>
