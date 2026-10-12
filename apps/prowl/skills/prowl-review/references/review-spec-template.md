# Review Specification — <owner/repo>#<n> (<batch-id>)

Fill every field. The reviewer sees only this document, the reviewer-instructions file, the review config, the axis-catalog sections named below, and the PRs themselves. Anything you leave out, it does not know. Save the filled copy to `specs/<repo>-<n>.md` and paste it inline in the reviewer prompt.

---

## 1. Batch brief

<Paste `batch-brief.md` in full, or paste the *Goal*, *PR roster*, *Dependency graph*, and *Shared surfaces* sections and give the absolute path to the rest.>

## 2. Axes

**Axes:** <catalog letters and names that apply to this PR; always "A. Batch Coherence & Integration", e.g. "A, B, C, E, J">
**Review config:** `<absolute path of review.md>`
**Catalog sections to read:** `<absolute path of axis-catalog.md>` → sections <letters>

## 3. Scope

**Your PR** (repo, number, title, head SHA, posting mode):
- <owner/repo>#<n> — <title> — `<headRefOid>` — formal/comment

**Depth expectation:** <e.g. "trace every query in the repository layer end-to-end for tenant key application"; "line-by-line on the handler and the migration; skim the DTOs">

## 4. Sibling PRs

Every other open PR in the batch has its own reviewer. Read a sibling's code only where it shares a surface with your PR (the other side of a contract, toggle, migration or registration). If you notice a defect in a sibling's own code, put it in *Out-of-scope observations* with one line of evidence and move on.

- <owner/repo>#<m> — `<headRefOid>` — OPEN/MERGED — shared surfaces: <what it produces or consumes from your PR>

## 5. Hypotheses to test

Each came from the orchestrator's mapping pass. **Report an outcome for every one** in the *Hypotheses — outcome* section of your report: CONFIRMED (becomes a finding with full evidence), REFUTED (say what you checked), or PARTIAL.

- H1 — <statement, where to look, why it looked wrong>
- H2 — …

## 6. Conventions to apply

<Absolute paths to CLAUDE.md files, convention docs, lint configs, or ADRs the reviewer must read before judging style/structure. "None known" is a valid value.>

## 7. Batch-specific questions

<Concrete questions about this PR's place in the batch, e.g. "Does the FE form's `startDate` serialize to the ISO format the API's validator expects?", "What happens if #4206 deploys before #1117's migration has run?">

## 8. Output

Return the report defined in `<SKILL_DIR>/references/reviewer-instructions.md` as your final message. Local finding IDs `R-<repo>-<n>-<k>`. Post nothing. Change nothing. Never mutate the user's clone.
