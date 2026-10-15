# PR-Owl Review — Output

Templates for everything this skill posts on GitHub: the review banner, the review body, the details file collapsed at its bottom, inline comments, replies on existing threads, and the comment that stands in for an approval when approvals are off. Prowl keeps your copy of this file in `~/.prowl/config/` (or `$PROWL_HOME/config/`): edit that one. Updates never overwrite a copy you've edited; Prowl's Update Notes say when this default changes.

Each template is a fenced block. Words in `<angle brackets>` are filled in for each post; everything else is posted as written. The hidden `<!-- prowl-review … -->` marker is added to every post whatever these templates say, because the re-run guard depends on it.

## Review banner

Every review body starts with this block, with `<verdict>` and `<batch-id>` filled in. Keep it in a fenced `text` block so GitHub keeps the spacing.

````markdown
```text
  ,_,
 (O,O)    PR-Owl Review
 (   )    <verdict>
 -"-"-    <batch-id>
```
````

## Comment prefix

Every inline comment, and every reply on an existing thread, starts with this text:

```text
🦉 **PR-Owl Review** · 
```

## Review body

One review per PR. Its body is the review banner, then this. Keep it short: the full write-up is in the details file collapsed at the bottom, not here.

`````markdown
**Summary:** <one sentence: what this PR does and the state it's in>

<one line per finding on this PR, most severe first, as "- **[<SEVERITY>]** <title> · <where>". <where> is `file:line` (followed by "with <counterpart PR link>" for a cross-PR finding), or "already raised: <link to the earlier comment, or to the reply>" for one someone else raised first, or "still open: <link to its thread>" for one from the previous review. Write "No issues found." when there are none>

<details>
<summary>📄 <details file name>: the full review, for whoever fixes these (copy it into your coding agent)</summary>

````markdown
<details file>
````

</details>
`````

Leave the `<details>` section out when the PR has no findings.

## Details file

The full review of one PR, as a markdown file named `prowl-review-<batch-id>-<repo>-<n>.md`, collapsed at the bottom of the review body. Write it for a coding agent that will fix the findings and has only this file and the repo: give it everything it needs, and leave nothing to the inline comments.

````markdown
# PR-Owl Review: <owner/repo>#<n> — <PR title>

- **PR:** <PR link>, reviewed at <head sha>
- **Verdict:** <verdict>
- **Batch:** <batch-id>, for <ticket key and link>
- **Goal of the work (as verified):** <goal>
- **This PR's role and merge order:** <role and merge order>
- **Other PRs in the batch:** <one per line: link — role — what this PR shares with it>
- **Conventions:** <the repo's convention files the reviewers applied, or "none found">

## How to use this file

Fix the findings below in order, most severe first. Each one quotes the code at <short head sha>; if the code has moved since, find it by the quote. A finding marked cross-PR names the PR that should carry the fix. Don't change behaviour beyond what a fix needs, and add or update the test each one names.

## Findings

### <F-id> [<SEVERITY>] <title>

- **Where:** `<file>:<line>` (<inline comment | not in the diff | already raised by @<author>: <link>>)
- **Axis:** <axis name>
- **Cross-PR:** <counterpart PR link; which PR carries the fix and why>   (cross-PR findings only)

**Code:**

```<language>
<the quoted lines>
```

**Problem:** <what is wrong, in full>

**Failure scenario:** <the concrete input, state or sequence that triggers it, and what happens>

**Fix:** <what to change, where, and why that fixes it, including any callers, siblings or data that must change with it>

**How to check the fix:** <the test to add or run, or the steps that show it's fixed>

**Verified:** <the verifier's confirmation, and any risk it noted in the suggested fix>

## Still open from the previous review

<re-reviews only: each prior finding still open, in the same form as above, with a link to its comment thread>

## Coverage

**Axes reviewed:**
<one line per axis, by its full name without the catalog letter, as "- Correctness & Logic">

**Checked and found clean:**
<one line per axis, the same way>

**Could not verify:**
<anything the reviewers or verifiers could not check, and why; or "nothing">
````

## No blocking issues (approvals off)

When Prowl's **Approve PRs** setting is off, a PR whose verdict would approve it (APPROVE or APPROVE WITH NITS) is posted as a comment instead of an approval. This goes right after the review banner, before the review body:

```markdown
### ✅ No blocking issues found
PR-Owl gives this PR its stamp of approval. It is waiting on a human reviewer's approval.
```

## Inline comment

One per verified finding anchored to the diff. Write it the way a teammate would: one or two plain sentences saying what goes wrong and when, then the fix. No headings, labels, severity or jargon; the details file has the rest.

```markdown
<comment prefix><one or two sentences: what goes wrong and when>

**Fix:** <the fix, in a sentence>
```

When someone else raised the same point only in a review summary or conversation comment, and understated it, the fix ends with:

```text
Also raised by @<author>: <link>
```

## Reply: still present

On an earlier thread (someone else's, resolved or outdated) whose problem is still in the code at head, or that understates it. Like an inline comment, keep it to a sentence or two; the details file has the rest:

```markdown
<comment prefix>This is still happening at <short head sha>: <one or two sentences: what goes wrong and when><, now at file:line, if it moved>

**Fix:** <the fix, in a sentence>
```

## Re-review replies

On a re-review, on each thread from the previous review. **Verified fixed** (the thread is then resolved):

```text
<comment prefix>Verified fixed in <sha>
```

**Still open:**

```text
<comment prefix>Still open as of <sha>: <one line why>
```
