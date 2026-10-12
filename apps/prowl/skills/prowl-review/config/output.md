# PR-Owl Review — Output

Templates for everything this skill posts on GitHub: the review banner, the review body, inline comments, replies on existing threads, and the comment that stands in for an approval when approvals are off. Prowl keeps your copy of this file in `~/.prowl/config/` (or `$PROWL_HOME/config/`): edit that one. Updates never overwrite a copy you've edited; Prowl's Update Notes say when this default changes.

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

One review per PR. Its body is the review banner, then this:

```markdown
**Batch:** <one line per sibling PR: link — role>
**Goal of the work (as verified):** <goal>
**This PR's role / merge-order notes:** <role and merge order>
**Summary:** <paragraph>

### Cross-PR findings involving this PR
<findings>
### Findings not anchored to the diff
<findings, each with file:line>
### Already raised by others
<severity, title and link to the earlier comment, one per line>
### Coverage
Axes reviewed: <axes> — checked and found clean: <axes>
```

## No blocking issues (approvals off)

When Prowl's **Approve PRs** setting is off, a PR whose verdict would approve it (APPROVE or APPROVE WITH NITS) is posted as a comment instead of an approval. This goes right after the review banner, before the review body:

```markdown
### ✅ No blocking issues found
PR-Owl gives this PR its stamp of approval. It is waiting on a human reviewer's approval.
```

## Inline comment

One per verified finding anchored to the diff:

```markdown
<comment prefix>**[<SEVERITY>]** <title>

**Problem:** <problem>
**Failure scenario:** <failure scenario>
**Suggested fix:** <suggested fix>

_Verified: <one clause from the verifier>_ · axis: <axis>
```

When someone else raised the same point only in a review summary or conversation comment, and understated it, the suggested fix ends with:

```text
Also raised by @<author>: <link>
```

## Reply: still present

On an earlier thread (someone else's, resolved or outdated) whose problem is still in the code at head, or that understates it:

```markdown
<comment prefix>**[<SEVERITY>]** Still present at <short head sha>: <title>

<failure scenario>
<current file:line, if it moved>
_Verified: <one clause from the verifier>_
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
