/prowl:prowl-review https://github.com/o/a/pull/1 https://github.com/o/b/pull/2

## Context from Prowl, the review poller

- Ticket: AB#42 "Thing" (https://dev.azure.com/o/p/_workitems/edit/42)
- This is review 1 of this ticket.
- It started automatically because the ticket was tagged for review. Nobody is watching this session: never stop to ask a question; make the reasonable call and say so in the closing message.
- Every review, first or not, re-checks each open PR-Owl thread on the PRs it reviews, whoever's Prowl raised it (the skill's Step 2), and gives each one its status in the review result (the skill's Step 8).
- The batch id: `rb-20260101-ab42-r1-0900-ab12`.
- The result path: /r/AB42-r1.result.json
- The checker command: `"/usr/bin/node" "/app/prowl.mjs" --check-result "/r/AB42-r1.result.json" --batch rb-20260101-ab42-r1-0900-ab12 --prs "https://github.com/o/a/pull/1,https://github.com/o/b/pull/2"`
