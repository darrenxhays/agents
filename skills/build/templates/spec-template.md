# Feature Spec: <feature title>

## User request
- Source: <inline text | Markdown file `<path>` | Jira ticket `<KEY-123>` (`<url>`)>

<quote or paraphrase the requested feature; when the source is a Markdown file or Jira ticket, restate its requirements here in full>

## Executive summary
<one paragraph: what should be built and why>

## Confirmed repository context
- `<path>`: <relevant pattern, component, API, test, config, or convention>
- `<path>`: <relevant pattern, component, API, test, config, or convention>

## Initial working-tree state
- Branch: `<branch>`
- Staged changes: <paths or `none`>
- Unstaged changes: <paths or `none`>
- Untracked paths: <paths or `none`>
- Overlap risk: <whether the requested work may touch pre-existing changes>

## Assumptions
- <assumption and why it is safe/minimal>

## Non-goals
- <explicitly out of scope>

## Proposed behavior
### Happy path
<what users/systems should experience>

### Edge cases and failure modes
- <edge case>: <expected behavior>

## Implementation plan
1. <smallest coherent implementation step with likely files/symbols>
2. <step>
3. <step>

## Files and symbols likely to change
- `<path>`: <expected change>
- `<path>`: <expected change>

## Test and validation plan
- Command: `<command>` — <what it validates>
- Command: `<command>` — <what it validates>

## Acceptance criteria
- [ ] <observable criterion>
- [ ] <observable criterion>
- [ ] <tests/docs/build criteria>

## Risks and mitigations
- <risk>: <mitigation>

## Codex build instructions
Build exactly the feature described above.

Reasoning effort: `<low|medium|high|xhigh|max>`

Effort rationale: <one sentence tied to the scope and risk of this implementation>

Constraints:
- Make the smallest complete change that satisfies the acceptance criteria.
- Preserve existing public APIs and behavior unless this spec explicitly changes them.
- Reuse existing patterns in the repository.
- Add or update tests for the changed behavior when relevant test coverage exists.
- Run the most relevant validation commands and report the results.
- Do not commit, push, create branches, open pull requests, rebase, reset, clean, stash, or rewrite git history.
- Leave all implementation changes uncommitted for Claude review and then manual user review.
- Stop and report blockers if the spec conflicts with the codebase or requires credentials, network access, secrets, or product decisions not present here.
