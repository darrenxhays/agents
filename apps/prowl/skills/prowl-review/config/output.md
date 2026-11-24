# PR-Owl Review — Output

Templates for everything Prowl posts on GitHub for a review: the comment when a review starts (with or without a ticket), the review banner, the review body, the details file collapsed at its bottom, inline comments, replies on existing threads, and the comment that stands in for an approval when approvals are off. Prowl fills them in itself, from the review's result: a review session never reads this file, and never writes to GitHub. The Builder uses it too, for the replies it posts after a feedback round on its PRs, and for that round's commits. Prowl keeps your copy of this file in `~/.prowl/config/` (or `$PROWL_HOME/config/`): edit that one. Updates never overwrite a copy you've edited; Prowl's Update Notes say when this default changes.

Each template is the first fenced block under its heading. Words in `<angle brackets>` are filled in for each post; everything else is posted as written. A line that holds only placeholders which all came out empty is dropped. If your copy lacks one of the templates below, or a placeholder or line Prowl needs in it (each section says which), Prowl uses this default's template for that heading, and the Log and the Update Notes name it. The hidden `<!-- prowl-review … -->` marker is added to every post whatever these templates say, because later reviews and the Builder find Prowl's posts by it.

## Review banner

Every review body starts with this block, with `<verdict>` and `<batch-id>` filled in. Keep it in a fenced `text` block so GitHub keeps the spacing.

````markdown
```text
╭─ PR-OWL ───────────────────────
│    ,_,
│   (◉,◉)    PR-Owl Review
│   /)  )    <verdict>
│  ──"─"──   <batch-id>
╰────────────────────────────────
```
````

## Comment prefix

Every inline comment, and every reply on an existing thread, starts with this text:

```text
🦉 **PR-Owl Review** ·
```

## Review started

Prowl posts this as a comment on each PR as soon as it starts reviewing it, so people can see a review is under way before they decide whether to review the PR themselves. `<ticket>` is the ticket key and `<ticket link>` its URL. It stays on the PR after the review is posted.

```markdown
🦉 **PR-Owl** is reviewing this PR for [<ticket>](<ticket link>). Its review lands here when it's done.
```

## Review finished

When a review of a ticket ends, Prowl edits its Review started comment on each PR it posted a review on to read this. `<n>` is the review's number for the ticket, `<ticket>` the ticket key and `<ticket link>` its URL. Prowl adds its hand-over notes to the same comment itself, hidden: the next review of the ticket carries on from them, whoever's Prowl runs it.

```markdown
🦉 **PR-Owl** finished review <n> of this PR for [<ticket>](<ticket link>). <sub>This comment holds PR-Owl's hand-over notes, so the next review carries on from this one, whoever's Prowl runs it. Please don't edit or delete it.</sub>
```

## Quick review started

The Review started comment for a quick review, which has no ticket: the PRs someone asked Prowl to review together (`n` in Prowl, or `prowl --review`). `<prs>` is the PRs under review, as links (`[repo#12](…)`), comma-separated.

```markdown
🦉 **PR-Owl** is reviewing <prs>. Its review lands on each PR when it's done.
```

## Review body

One review per PR. Its body is the review banner, then this. `<summary>` is one sentence on what the PR does and the state it's in; `<finding lines>` is a *Finding line* per finding that counts toward the verdict, most severe first (or "No issues found."), followed by what wasn't checked, if anything; `<details block>` is the *Details block*, left out when there is nothing to detail. Keep all three.

```markdown
**Summary:** <summary>

<finding lines>

<details block>
```

## Finding line

One per finding in the review body. `<SEVERITY>` is CRITICAL, HIGH, MEDIUM, LOW or NIT; `<where>` is `file:line` (with the counterpart PR for a cross-PR finding), "already raised: <link>" for one someone else raised first, or "still open: <link>" for an earlier PR-Owl finding. Keep all three.

```markdown
- **[<SEVERITY>]** <title> · <where>
```

## Details block

The details file, collapsed at the bottom of the review body. `<details file name>` is `prowl-review-<batch-id>-<repo>-<n>.md`: keep it on the `<summary>` line, where the Builder and later reviews find the file. `<details fence>` is a fence longer than any inside the file.

```markdown
<details>
<summary>📄 <details file name>: the full review, for whoever fixes these (copy it into your coding agent)</summary>

<details fence>markdown
<details file>
<details fence>

</details>
```

## Details continued

Ends the first part of a details file too long for one review body (GitHub's limit is 65,536 characters). `<part 2 link>` is the comment holding the rest.

```markdown
_The details file continues in [part 2](<part 2 link>), a comment on this PR._
```

## Details part 2

The rest of a details file that didn't fit, posted as a comment on the PR before the review. Keep `<details file name>` and the words "part 2" on the `<summary>` line: the Builder joins the two parts by them.

```markdown
<details>
<summary>📄 <details file name> (part 2): the rest of the full review</summary>

<details fence>markdown
<details file>
<details fence>

</details>
```

## Details file

The full review of one PR, for whoever fixes the findings. `<findings>` is a *Details finding* per new finding that counts, `<still open>` the same for earlier PR-Owl findings still in the code, and `<parked section>` the *Details parked* template when something is parked: keep those three. The rest: `<repo>`, `<n>`, `<PR title>`, `<PR link>`, `<head sha>` and `<short sha>` (the commit reviewed), `<verdict>`, `<batch-id>`, `<ticket>`, `<goal>`, `<role>`, `<merge order>`, `<related>`, `<conventions>`, `<axes>`, `<clean>`, `<unverified>`.

`````markdown
# PR-Owl Review: <repo>#<n> — <PR title>

- **PR:** <PR link>, reviewed at <head sha>
- **Verdict:** <verdict>
- **Batch:** <batch-id>, for <ticket>
- **Goal of the work (as verified):** <goal>
- **This PR's role and merge order:** <role> <merge order>
- **Other PRs in the batch:** <related>
- **Conventions:** <conventions>

## How to use this file

Fix the findings below in order, most severe first. Each one quotes the code at <short sha>; if the code has moved since, find it by the quote. A finding marked cross-PR names the PR that should carry the fix. Don't change behaviour beyond what a fix needs, and add or update the test each one names.

## Findings

<findings>

## Still open from the previous review

<still open>

<parked section>

## Coverage

**Axes reviewed:**
<axes>

**Checked and found clean:**
<clean>

**Could not verify:**
<unverified>
`````

## Details finding

One finding in the details file. Keep the line `### <id> [<SEVERITY>] <title><ref>` as it is: later reviews read a finding's title and severity from it. `<ref>` is the earlier finding's batch id and id, in brackets, for one carried over. `<cross-pr>` is a line naming the counterpart PR or an outside consumer, dropped when there is none.

`````markdown
### <id> [<SEVERITY>] <title><ref>

- **Where:** <where>
- **Axis:** <axis>
<cross-pr>

**Code:**

<code>

**Problem:** <explanation>

**Failure scenario:** <scenario>

**Fix:** <fix detail>

**How to check the fix:** <check>

**Verified:** <verification>
`````

## Details parked

The details file's section for parked findings: ones a person answered on the thread, or that only a person can settle outside the code. Keep the line `## Parked`: the Builder leaves the threads listed under it to a person.

```markdown
## Parked

<parked lines>
```

## Parked line

One parked finding. Keep `<link>` (its thread) at the end of the line.

```markdown
- <title> (<ref>): <note> · <link>
```

## No blocking issues (approvals off)

When Prowl's **Approve PRs** setting is off, a PR whose verdict would approve it (APPROVE or APPROVE WITH NITS) is posted as a comment instead of an approval. This goes right after the review banner, before the review body. With Approve PRs on, it is never posted, even on a PR Prowl can't approve (your own):

```markdown
### ✅ No blocking issues found
PR-Owl gives this PR its stamp of approval. It is waiting on a human reviewer's approval.
```

## Inline comment

One per finding anchored to the diff: `<problem>` is one or two plain sentences saying what goes wrong and when, `<fix>` the fix in a sentence. No headings, labels, severity or jargon; the details file has the rest.

```markdown
<comment prefix> <problem>

**Fix:** <fix>
```

## Also raised by

Ends an inline comment for a problem someone else raised only in a review summary or conversation comment, and understated.

```text
Also raised by @<author>: <link>
```

## Cross-PR note

Ends an inline comment for a finding that involves another PR of the batch: `<counterpart>` is that PR, `<why>` what the two share.

```text
Goes with <counterpart>: <why>
```

## Reply: still present

On an earlier thread (someone else's, resolved or outdated) whose problem is still in the code at the commit reviewed, or that understates it. `<moved>` says where the code is now, when the thread is outdated.

```markdown
<comment prefix> This is still happening at <sha>: <problem><moved>

**Fix:** <fix>
```

## Reply: verified fixed

On the thread of an earlier PR-Owl finding, whoever's Prowl raised it, once it is verified fixed (the thread is then resolved). `<sha>` is the fixing commit.

```text
<comment prefix> Verified fixed in <sha>
```

## Reply: still open

On the thread of an earlier PR-Owl finding still in the code. `<note>` is one line on why.

```text
<comment prefix> Still open as of <sha>: <note>
```

## Reply: no longer applies

On the thread of an earlier PR-Owl finding that no longer applies: the code is gone, or the author's reply shows there is nothing to fix (the thread is then resolved).

```text
<comment prefix> No longer applies as of <sha>: <note>
```

## Fix reply

After a Builder feedback round, Prowl posts this on each thread the round fixed, after pushing the fix. `<sha>` is the pushed commit and `<note>` the session's one-line note on what it changed. Prowl never resolves the thread: the next review resolves it once it verifies the fix. Prowl adds a hidden `<!-- prowl-fix … -->` marker to each reply, so a restart never posts one twice.

```text
<comment prefix> Fixed in <sha>: <note>
```

## Dispute reply

On each thread a feedback round disputed instead of changing the code, with `<note>` its evidence. The next review weighs it, and resolves the thread if it holds:

```text
<comment prefix> Not changed: <note>
```

## Fix commit message

The message of each commit a feedback round makes. `<ticket>` is the ticket key, `<summary>` a short line on what changed, `<repo>#<n>` the PR and `<round>` the round.

```text
<ticket>: <summary>

Fixes review findings on <repo>#<n> (feedback round <round>).
```
