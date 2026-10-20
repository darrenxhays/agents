# Plan: <feature title>

## User request
- Source: <inline text | Markdown file `<path>` | ticket `<id>` (`<url>`)>

<the requested feature; when the source is a file or ticket, restate its requirements, acceptance criteria, and relevant comments in full>

## Summary
<one paragraph: what will be built and why>

## Repository context
- `<path>`: <relevant pattern, component, API, test, config, or convention>

## Working tree before the build
- Snapshot: `<worktree file from prepare.sh>`
- Overlap risk: <whether the work may touch pre-existing changes, or `none`>

## Assumptions
- <assumption and why it is safe>

## Non-goals
- <explicitly out of scope>

## Proposed behavior
<what users or systems will experience, then each edge case or failure mode and its expected behavior>

## Implementation steps
1. <smallest coherent step with the files and symbols it changes>

## Validation
Checks the implementer can run in its sandbox (no network or local services unless the README's opt-in is on):
- `<command>`: <what it validates>

Checks Claude runs after the implementer finishes:
- `<command>`: <what it validates>

## Acceptance criteria
- [ ] <observable criterion, covered by a check above or a described manual check>

## Risks and mitigations
- <risk>: <mitigation>

## Decisions that need your sign-off
<Every choice that crosses a boundary, including choices the request itself made: for example auth, permissions, and scopes; billing or usage metering; a public API contract; stored data and schemas; infrastructure; other repositories; anything with consequences elsewhere. These are examples, not a checklist. One line each, or `None.`>
1. <decision>: <its consequence>

## Open questions
<Each ambiguity, competing interpretation, or simpler approach than the request suggests, one line each, or `None.`>
