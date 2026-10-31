# PR-Owl Review — How Each PR Is Reviewed

The stance each reviewer takes, what it looks for, how findings are rated, and how a PR's verdict follows from them. Prowl keeps your copy of this file in `~/.prowl/config/` (or `$PROWL_HOME/config/`): edit that one. Updates never overwrite a copy you've edited.

## Reviewer stance

- **Try to break it.** For every changed function: what input, state, timing, environment, or *sibling-PR state* makes this fail?
- **Distrust the PR description and the batch brief's stated goal.** Verify the code does what is claimed. Undocumented behaviour changes are findings.
- **Ask what the author forgot.** Missing handling, missing test, missing wiring, missing data change, missing cleanup. Absence is where the expensive bugs are.
- **Steelman first, then attack.** Understand why it was written this way before arguing it is wrong. Do not nitpick style until you have checked correctness.
- **Use the batch.** The brief tells you what the sibling PRs assume. A value this PR produces that a sibling consumes is a contract; check it byte-for-byte.
- **Trace the critical paths line by line**, tracking state by hand. Do not skim.

## What to look for

Axis A goes into every PR's review. The other areas are prompts, not checklists: a reviewer covers the ones its spec names, which are the ones its PR touches. Add your own checks, or cut what you don't need.

### A. Batch Coherence & Integration — ALWAYS INCLUDED

The axis no single-PR review can perform. Every PR's reviewer covers it for that PR, focused on the **shared surfaces and dependency edges** in the batch brief rather than on every line, reading the sibling PR on the other side of each.

**Checklist**

- **Contracts across PRs.** For each producer/consumer pair in the brief: does what one side produces (a function or API signature, a data or message format, field names and casing, nullability, enum values, a file or wire format, a config key, a flag name, a registration) exactly match what the other side expects? Read both sides; do not trust names.
- **Merge and deploy order.** Is the required order stated anywhere? What is the system's behaviour in every intermediate state — A merged, B not; B merged, A not; both merged but one not yet released or deployed? Silent no-ops in an intermediate state are findings, not features, unless a toggle deliberately produces them.
- **Feature toggles / flags gating the set.** Same toggle name and semantics in every PR? Default value consistent? Is there a path where the flag is on in one part of the system and off in another and produces an inconsistent state?
- **Stored data and formats vs code.** If the batch changes a schema, stored format, or serialized shape: is every change compatible with the code version that will run against it during rollout, in both directions? Do two PRs change the same data? Will migration or version numbers collide at merge?
- **Completeness against the stated goal.** Walk the goal from the brief and check each implied piece exists in some PR: every new piece is wired in where the codebase requires it (registered, imported, exported, routed, mounted, or listed), every new output has its consumer, every data change has a way back, every new setting is supplied wherever the code runs, every new path has tests. Missing pieces are Medium+ findings on the PR that should own them, with the *fix-owner PR* named.
- **Duplicated or divergent copies.** The same helper, constant, mapping, or validation implemented in two PRs — do they agree? Which should own it?
- **Naming and versioning consistency.** Versions bumped where consumers need them; the same concept named the same way across PRs and repos.
- **Scope drift.** Changes present in a PR that are not part of the stated goal — flag them; they are un-reviewed by the work item and often untested.

Findings on this axis are usually *cross-PR*: name **both PRs** and the **fix-owner PR** in every finding.

### Other areas

Covered where a PR touches them, at the depth the change deserves:

- **Correctness**: logic, edge cases, does the code do what the PR claims.
- **Errors and resilience**: failure paths, partial failure, leaks, retries, timeouts.
- **Concurrency**: shared state, missing awaits, races, idempotency under retries.
- **Security**: outside input reaching a sink, authorization and data scoping on every access path, secrets.
- **Data and migrations**: stored formats, compatibility during rollout, transactions, caches.
- **Performance**: unbounded work or data, calls in loops, blocking hot paths.
- **Interfaces**: breaking or inconsistent changes to an API, export, CLI or message format.
- **Conventions**: the repo's documented rules (the spec lists them), duplicated logic.
- **Tests**: changed behaviour with no test, tests that would pass with the code broken.
- **Operations and UI**: config and flags per environment, rollback, logging; lifecycle, states and accessibility in anything a person sees.

## Severity

Reviewers rate with these definitions and verifiers re-rate against them. Change the definitions freely, but keep the five names: the verdict table below, the verification split and Prowl's report counts use them.

- **Critical** — data loss, security hole, or crash in production.
- **High** — incorrect behaviour on realistic inputs.
- **Medium** — latent bug, maintainability trap, or meaningful test gap.
- **Low** — minor robustness or clarity.
- **Nit** — style.

Do not inflate to look thorough; do not soften to be polite.

## Verdict

Each PR's verdict comes from the highest severity among its verified findings, and is stated in its review body in every mode. The `event` is what the review is posted as; with Prowl's **Approve PRs** setting off, `APPROVE` posts as `COMMENT` with the *No blocking issues* text from `output.md`. Prowl's History view colours a verdict by its first word: BLOCK red, REQUEST orange, APPROVE green.

| Highest verified severity on this PR | Verdict | `event` in formal mode | `event` in comment / no-verdict mode |
|---|---|---|---|
| Critical | BLOCK | `REQUEST_CHANGES` | `COMMENT` |
| High or Medium | REQUEST CHANGES | `REQUEST_CHANGES` | `COMMENT` |
| Low or Nit only | APPROVE WITH NITS | `APPROVE` | `COMMENT` |
| none | APPROVE | `APPROVE` | `COMMENT` |
