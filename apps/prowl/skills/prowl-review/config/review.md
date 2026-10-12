# PR-Owl Review — How Each PR Is Reviewed

The stance each reviewer takes, how findings are rated, and how a PR's verdict follows from them. The checklists themselves are in `axis-catalog.md`, next to this file. To keep your version across updates, copy either file to `~/.prowl/config/` (or `$PROWL_HOME/config/`) and edit that copy instead.

## Reviewer stance

- **Try to break it.** For every changed function: what input, state, timing, environment, or *sibling-PR state* makes this fail?
- **Distrust the PR description and the batch brief's stated goal.** Verify the code does what is claimed. Undocumented behaviour changes are findings.
- **Ask what the author forgot.** Missing handling, missing test, missing wiring, missing data change, missing cleanup. Absence is where the expensive bugs are.
- **Steelman first, then attack.** Understand why it was written this way before arguing it is wrong. Do not nitpick style until you have checked correctness.
- **Use the batch.** The brief tells you what the sibling PRs assume. A value this PR produces that a sibling consumes is a contract; check it byte-for-byte.
- **Trace the critical paths line by line**, tracking state by hand. Do not skim.

## Severity

Reviewers rate with these definitions and verifiers re-rate against them. Change the definitions freely, but keep the five names: the verdict table below, the verification split and Prowl's report counts use them.

- **Critical** — data loss, security hole, or crash in production.
- **High** — incorrect behaviour on realistic inputs.
- **Medium** — latent bug, maintainability trap, or meaningful test gap.
- **Low** — minor robustness or clarity.
- **Nit** — style.

Do not inflate to look thorough; do not soften to be polite.

## Verdict

Each PR's verdict comes from the highest severity among its verified findings, and is stated in its review body in every mode. The `event` is what the review is posted as. Prowl's History view colours a verdict by its first word: BLOCK red, REQUEST orange, APPROVE green.

| Highest verified severity on this PR | Verdict | `event` in formal mode | `event` in comment / no-verdict mode |
|---|---|---|---|
| Critical | BLOCK | `REQUEST_CHANGES` | `COMMENT` |
| High or Medium | REQUEST CHANGES | `REQUEST_CHANGES` | `COMMENT` |
| Low or Nit only | APPROVE WITH NITS | `APPROVE` | `COMMENT` |
| none | APPROVE | `APPROVE` | `COMMENT` |
