# PR-Owl Build — Rules

How a Builder session investigates, plans and builds a ticket, and works through review feedback on its PRs. Prowl keeps your copy of this file in `~/.prowl/config/` (or `$PROWL_HOME/config/`): edit that one. Updates never overwrite a copy you've edited. To change how the Builder works, edit or replace any section here: Prowl's skill keeps the stages and the result it hands back, so the app keeps working whatever you write. The `CLAUDE.md` files in your Projects Directory and in each repo win over this file; the checks Prowl runs before a push are in `checks.json`.

## Investigate

- Start from the ticket's goal and acceptance criteria, then find where the change belongs: the module, the layer, the existing pattern for this kind of change.
- Trace upstream (what it calls or depends on: services, APIs, packages, schemas, events consumed, config) and downstream (what calls or consumes it: services, UIs, subscribers, jobs, contracts, tests) far enough to know what else must change.
- Prefer what the codebase already does over anything new.

## Plan

- Name each repo, its base branch and why it changes.
- List the changes, the tests that prove them, and the risks (data, contracts, rollout).
- Keep it to what the ticket asks. A refactor, rename or dependency bump the ticket doesn't need is out of scope.

## Build

- Make the smallest change that meets the ticket, in the repo's own style.
- Every behaviour you add or change gets a test, unless the repo has no tests for that layer: then say so in the PR body.
- Run the repo's checks before you commit, and fix what you broke.

## Questions

Ask only when no amount of reading settles it:

- a product, design or naming choice the ticket doesn't make;
- a trade-off with real cost either way (performance against simplicity, a breaking change);
- something that needs access or knowledge outside the repos.

Offer two or three options, and the default you would take.

## Review feedback

### Fix

Fix a finding or thread when the code can resolve it and the change stays within the ticket: a verified bug, missing handling or test, a clear request from a reviewer, or a one-line nit. Fix the root cause: search for every caller and sibling of the code you change.

### Dispute

Dispute only with concrete evidence: the line that already handles it, a test that shows it, or the ticket or a doc that asks for the current behaviour. Say it in a sentence or two, at `file:line`.

### Ask

Ask when the feedback needs a decision only the user can make, or contradicts the ticket. Put what you checked in `searched`.

### Park

Leave an item, with no change and no reply, when only a person can do it outside the code: creating a CI pipeline, tracker or permissions config, a product decision already raised.

## Scope

- Don't refactor, rename or reformat beyond what the ticket needs.
- Don't bump dependencies unless the ticket asks for it.
- Don't touch CI workflow files unless the ticket is about them: Prowl won't push such a change without you (Paths that need a person).
