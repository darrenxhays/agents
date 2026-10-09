# Feature Spec: <feature title>

## User request
- Source: <inline text | Markdown file `<path>` | ticket `<id>` (`<url>`)>
- Approved plan: `<plan path in the configured output directory>`

<quote or paraphrase the requested feature; when the source is a Markdown file or ticket, restate its requirements here in full>

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

## Implementation subtasks
Each subtask is one implementer run: Codex, or a Claude subagent when Codex is not installed. Subtasks in the same wave run at the same time in this working tree and must own different files; a later wave starts only after the previous one finishes. Most changes are a single subtask.

### S1: <subtask title>
- Wave: `1`
- Owns: `<path>`, `<path>`
- Model: `<latest-version model for the current mode>`
- Effort: `<effort the model supports>`
- Rationale: <one sentence tying the model and effort to the scope and risk of this subtask>
- Build: <what this subtask implements and which acceptance criteria it covers>

## Build instructions
Build exactly your subtask of the feature described above.

Constraints:
- Make the smallest complete change that satisfies the acceptance criteria.
- Preserve existing public APIs and behavior unless this spec explicitly changes them.
- Reuse existing patterns in the repository.
- Add or update tests for the changed behavior when relevant test coverage exists.
- Run the most relevant validation commands and report the results.
- Do not commit, push, create branches, open pull requests, rebase, reset, clean, stash, or rewrite git history.
- Leave all implementation changes uncommitted for Claude review and then manual user review.
- Stop and report blockers if the spec conflicts with the codebase or requires credentials, network access, secrets, or product decisions not present here.
