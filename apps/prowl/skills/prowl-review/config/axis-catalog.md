# PR-Owl Review — Axis Catalog

The orchestrator picks the axes for each PR's review spec from this catalog (SKILL.md Step 3). Each entry gives: what the axis covers, **when to include it** (triggers), and the checklist the PR's reviewer works through. Reviewers read only the sections named in their spec; the orchestrator reads the whole file. Add, remove or edit axes and checklists to change what reviewers look for; an axis marked ALWAYS INCLUDED goes into every PR's spec. To keep your version across updates, copy this file to `~/.prowl/config/axis-catalog.md` (or `$PROWL_HOME/config/`) and edit that copy instead.

---

## A. Batch Coherence & Integration — ALWAYS INCLUDED

The axis no single-PR review can perform. Every PR's reviewer covers it for that PR, focused on the **shared surfaces and dependency edges** in the batch brief rather than on every line, reading the sibling PR on the other side of each.

**Checklist**

- **Contracts across PRs.** For each producer/consumer pair in the brief: does the shape produced (route, method, DTO fields, casing, nullability, enum values, event schema/topic/key, config key, toggle name, registry entry, DI registration) exactly match what the consumer expects? Read both sides; do not trust names.
- **Merge and deploy order.** Is the required order stated anywhere? What is the system's behaviour in every intermediate state — A merged, B not; B merged, A not; both merged but one not yet deployed? Silent no-ops in an intermediate state are findings, not features, unless a toggle deliberately produces them.
- **Feature toggles / flags gating the set.** Same toggle name and semantics in every PR? Default value consistent? Is there a path where toggle ON in one service and OFF in another produces an inconsistent state?
- **Migrations vs code.** Is every schema change compatible with the code version that will be running against it during rollout, in both directions? Do two PRs migrate the same table? Are migration sequence numbers going to collide at merge?
- **Completeness against the stated goal.** Walk the goal from the brief and check each implied piece exists in some PR: the registration for every handler, the host mount for every UI, the consumer for every event, the rollback for every migration, the config in every environment, the tests for every new path. Missing pieces are Medium+ findings on the PR that should own them, with the *fix-owner PR* named.
- **Duplicated or divergent copies.** The same helper, constant, mapping, or validation implemented in two PRs — do they agree? Which should own it?
- **Naming and versioning consistency.** Package/API versions bumped where consumers need them; the same concept named the same way across repos.
- **Scope drift.** Changes present in a PR that are not part of the stated goal — flag them; they are un-reviewed by the work item and often untested.

Findings on this axis are usually *cross-PR*: name **both PRs** and the **fix-owner PR** in every finding.

---

## B. Correctness & Logic

**Include when:** any non-trivial code change.

- Off-by-one, inverted conditions, wrong operators, boolean logic errors
- Edge cases: empty, null/undefined, zero, negative, unicode, very large, duplicates
- Boundary/fencepost errors in loops, ranges, pagination, slicing
- Wrong assumptions about ordering, uniqueness, data shape, casing
- State machines: unreachable states, invalid transitions, missing terminal handling
- Floating point comparison, integer overflow/truncation, timezone/DST, locale
- Does the code do what the PR description claims — no more, no less?

Trace the two or three most critical code paths line by line, tracking state by hand.

---

## C. Error Handling & Resilience

**Include when:** the batch adds I/O, network calls, parsing, external-service calls, retries, or background work. Often merged with B on small batches.

- Swallowed exceptions, overly broad catches, errors logged but not handled
- Missing handling for I/O, network, parsing, external-service failures
- Partial failure: step 2 of 3 fails — is state consistent? Is there compensation?
- Resource leaks: unclosed files/connections/subscriptions/timers
- Retries: idempotent? backoff? can they amplify load?
- Timeouts and cancellation propagated?

---

## D. Concurrency & Async

**Include when:** shared mutable state, async/await, background jobs, message consumers, locks, caches, or anything that can run twice at once.

- Races, TOCTOU, check-then-act on shared state
- Missing awaits, unobserved task/promise failures, fire-and-forget
- Deadlocks, lock ordering, locks held across I/O
- Non-thread-safe use of libraries or singletons
- Idempotency of consumers/handlers under redelivery or duplicate events

---

## E. Security & Tenant Isolation

**Include when:** new or changed endpoints, auth/authz code, data access with a tenant dimension, deserialization, file/URL handling, secrets/config, anything user-controlled reaching a sink. On multi-tenant systems, include it whenever data access changes.

- Injection: SQL, command, path traversal, template, log, header
- Authorization on every new/changed access path — trace from entry point to data, not just "has an attribute"
- Tenant isolation: is the tenant key applied on every query/write in the changed path, including joins, bulk operations, and background jobs? Can a caller supply a tenant identifier that is trusted?
- Secrets, tokens, PII in code, logs, errors, URLs, test fixtures
- Unsafe deserialization, SSRF, open redirects, insecure defaults, permissive CORS
- Input validation at the boundary versus trust deep in the stack
- Pipeline/config changes that widen access or disable a control

---

## F. Data Integrity, Persistence & Migrations

**Include when:** schema changes, migration scripts, repository/query changes, caching, serialized formats, event payloads.

- Migrations: reversible? safe on large tables (locks, online-ness)? idempotent? compatible with the old code during deploy?
- Sequence numbering/naming per project convention; collision with siblings in the batch
- Transaction boundaries: multi-step writes that must be atomic and are not
- Constraints and indexes for new query patterns; nullability matching code assumptions
- Cache invalidation and stale reads
- Backward/forward compatibility of serialized formats, APIs, and events

---

## G. Performance & Scalability

**Include when:** new queries, loops over collections from storage, new hot paths, large payloads, caches, or anything invoked per request/per row. Often merged with D or F.

- N+1, queries in loops, missing indexes for new patterns
- Unbounded growth: unpaginated reads, unbounded caches/queues, whole datasets in memory
- Accidental O(n²), repeated expensive computation
- Hot-path allocations; synchronous blocking of event loops/thread pools
- Payload size and serialization cost on chatty endpoints

---

## H. API & Contract Design (within a PR)

**Include when:** public API, library, or event surface changes. Cross-PR contract *matching* belongs to A; this axis is about the quality of each surface on its own.

- Breaking changes without versioning; renamed/removed fields; changed semantics behind an unchanged name
- Inconsistency with existing conventions in the same codebase (paging, filtering, error shapes, casing)
- Leaky abstractions; return types that force error-prone handling at call sites
- Misleading names; optional parameters that change behaviour silently

---

## I. Maintainability & Conventions

**Include when:** the repo has documented rules (a `CLAUDE.md`, convention docs, architecture boundaries) or the batch is large enough that structure matters. The spec must list the convention files to read.

- Violations of documented project rules — cite the rule
- Duplication of logic that already exists in the codebase (go look for it)
- God functions/classes, deep nesting, boolean-flag parameters, dead code added
- Magic numbers/strings; copy-paste with subtle divergence
- Comments that lie or will rot; TODO/FIXME/HACK without tracking
- Architectural boundary violations (layer depending on the wrong layer)

---

## J. Testing Gaps

**Include when:** always, unless the batch is docs/config only.

- Which changed lines and branches have NO test coverage? Be specific — name functions and branches.
- Tests that assert nothing meaningful, test the mock, or would pass with the code broken (mentally mutate the code; would any test fail?)
- Missing negative, error-path, boundary, and concurrency tests
- Flakiness: time, ordering, shared fixtures, real network
- Over-mocking that hides integration bugs — especially for the cross-PR contracts from the brief
- Controller/handler tests that mock the mediator/dispatcher and therefore cannot catch missing registrations

---

## K. Operational & Deployment

**Include when:** config, toggles, pipelines, infra, logging, or anything that behaves differently per environment.

- Config needed in other environments; secrets sourced correctly; env-specific values hardcoded
- Feature flags: default, cleanup plan, behaviour when flipped mid-request, consistency across services (coordinate with A)
- Deploy-order dependencies and rollback safety — can this be reverted cleanly after running?
- Logging: missing on new failure paths, noisy on hot paths, PII in logs, correlation propagated
- Metrics/alerts for new failure modes
- Pipeline changes: pinned template/action versions, permissions widened, steps skipped

---

## L. Frontend / UI

**Include when:** the batch touches UI code (components, templates, styles, client state, routing, micro-frontend lifecycle).

- Lifecycle: subscriptions/listeners/timers cleaned up on destroy; micro-frontend mount/unmount symmetry
- State: stale state after navigation, race between fetch and unmount, optimistic updates without rollback
- Forms: validation matching the backend contract from the brief; disabled/loading states; double-submit
- Security: unsanitized HTML binding, URL construction from user input, tokens in storage/URLs
- Accessibility: keyboard reachability, labels, focus management on dialogs
- i18n: hardcoded user-facing strings where the project localizes
- Error/empty/loading states rendered, not just the happy path
- Host integration: the mount point/registration the brief says must exist (coordinate with A)

---

## M. Infrastructure-as-Code & Pipelines

**Include when:** ARM/Bicep/Terraform, YAML pipelines, Dockerfiles, Kubernetes manifests, or deployment parameters change. Merge into K when small.

- Drift between environments; parameter files out of sync
- Resource naming/tagging conventions; quotas; SKU changes with cost or capability impact
- Secrets referenced from a vault, never inline
- Pipeline permissions, triggers on the right branches, template versions pinned
- Preflight/validation steps present for deploy stages

---

## Choosing axes — worked example

Batch: API PR (new endpoint + migration, 600 lines), BFF PR (proxy endpoint, 120 lines), FE PR (new component + registry entry, 900 lines), host PR (mount div + toggle, 80 lines).

Specs, one per PR: **API** — A (contract with the BFF, merge order vs the migration), B, C, E, F, J, K; **BFF** — A (contracts with API and FE), B, C, J; **FE** — A (contract with the BFF, registry entry vs the host mount, toggle name), B, L, J; **host** — A (mount and toggle vs the FE), L, K. Four reviewers.
