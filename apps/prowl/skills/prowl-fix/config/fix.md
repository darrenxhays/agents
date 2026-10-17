# PR-Owl Fix — Rules

How a fix session sorts and handles the findings and threads on one of your PRs. Prowl keeps your copy of this file in `~/.prowl/config/` (or `$PROWL_HOME/config/`): edit that one. Updates never overwrite a copy you've edited. Team-specific rules belong here or in the repo's own `CLAUDE.md`; the checks Prowl runs before a push are in `checks.json`.

## Fix

Fix a finding or thread when the code can resolve it and the change stays within what the PR is for:

- a bug, missing handling, missing test or wiring the review verified;
- a reviewer's or teammate's request that is clear and doesn't contradict the ticket;
- a nit, when it's a one-line change.

Fix the root cause, not the symptom: search for every caller and sibling of the code you change.

## Dispute

Dispute only with concrete evidence: the line that already handles it, a test that shows it, the ticket or a doc that asks for the current behaviour. Say it in a sentence or two, with the file and line. Dispute when:

- the finding misreads the code;
- another PR in the batch already handles it (name the PR);
- fixing it would go against the ticket.

## Ask

Ask the user only when no amount of reading settles it:

- a product, design or naming choice the ticket doesn't make;
- a trade-off with real cost either way (performance against simplicity, a breaking change);
- something that needs access or knowledge outside the repo.

Before asking, look in the ticket text and details file, the other threads, the past answers in the brief, and the code. Put what you checked in the question's `searched` line, offer two or three options, and recommend one.

## Park

Leave an item parked, with no change and no reply, when the details file lists it under *Parked*, or when only a person can do it outside the code: creating a CI pipeline, tracker or permissions config, a product decision already raised.

## Scope

- Don't refactor, rename or reformat beyond what a fix needs.
- Don't bump dependencies unless a finding asks for it.
- Don't touch CI workflow files: Prowl won't push a change to them (Paths that need a person).
