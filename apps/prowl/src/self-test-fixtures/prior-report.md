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
