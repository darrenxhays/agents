# PR-Owl Review — Axis Catalog

The orchestrator picks the axes for each PR's review spec from this catalog (SKILL.md Step 3). Each entry gives: what the axis covers, **when to include it** (triggers), and the checklist the PR's reviewer works through. Reviewers read only the sections named in their spec; the orchestrator reads the whole file. Add, remove or edit axes and checklists to change what reviewers look for; an axis marked ALWAYS INCLUDED goes into every PR's spec. To keep your version across updates, copy this file to `~/.prowl/config/axis-catalog.md` (or `$PROWL_HOME/config/`) and edit that copy instead.

---

## A. Batch Coherence & Integration — ALWAYS INCLUDED

The axis no single-PR review can perform. Every PR's reviewer covers it for that PR, focused on the **shared surfaces and dependency edges** in the batch brief rather than on every line, reading the sibling PR on the other side of each.

**Checklist**

- **Contracts across PRs.** For each producer/consumer pair in the brief: does what one side produces (a function or API signature, a data or message format, field names and casing, nullability, enum values, a file or wire format, a config key, a flag name, a registration) exactly match what the other side expects? Read both sides; do not trust names.
- **Merge and deploy order.** Is the required order stated anywhere? What is the system's behaviour in every intermediate state — A merged, B not; B merged, A not; both merged but one not yet released or deployed? Silent no-ops in an intermediate state are findings, not features, unless a toggle deliberately produces them.
- **Feature toggles / flags gating the set.** Same toggle name and semantics in every PR? Default value consistent? Is there a path where the flag is on in one part of the system and off in another and produces an inconsistent state?
- **Stored data and formats vs code.** If the batch changes a schema, stored format, or serialized shape: is every change compatible with the code version that will run against it during rollout, in both directions? Do two PRs change the same data? Will migration or version numbers collide at merge?
- **Completeness against the stated goal.** Walk the goal from the brief and check each implied piece exists in some PR: every new piece is wired in where the codebase requires it (registered, imported, exported, routed, mounted, or listed), every new output has its consumer, every data change has a way back, every new setting is supplied wherever the code runs, every new path has tests. Missing pieces are Medium+ findings on the PR that should own them, with the *fix-owner PR* named.
- **Duplicated or divergent copies.** The same helper, constant, mapping, or validation implemented in two PRs — do they agree? Which should own it?
- **Naming and versioning consistency.** Versions bumped where consumers need them; the same concept named the same way across PRs and repos.
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

**Include when:** the batch adds I/O, network or external calls, parsing, retries, or background work. Often merged with B on small batches.

- Swallowed exceptions, overly broad catches, errors logged but not handled
- Missing handling for I/O, network, parsing, external-service failures
- Partial failure: step 2 of 3 fails — is state consistent? Is there compensation?
- Resource leaks: unclosed files/connections/subscriptions/timers
- Retries: idempotent? backoff? can they amplify load?
- Timeouts and cancellation propagated?

---

## D. Concurrency & Async

**Include when:** shared mutable state, async code, threads, background work, event or message handlers, locks, caches, or anything that can run twice at once.

- Races, TOCTOU, check-then-act on shared state
- Missing awaits, unobserved task/promise failures, fire-and-forget
- Deadlocks, lock ordering, locks held across I/O
- Non-thread-safe use of libraries or singletons
- Idempotency of handlers under retries, redelivery, or duplicate input

---

## E. Security & Data Isolation

**Include when:** new or changed entry points (anything that accepts outside input), authentication or authorization code, access to data scoped by user, account, or tenant, deserialization, file/URL handling, secrets/config, anything user-controlled reaching a sink. If the system separates data by user, account, or tenant, include it whenever data access changes.

- Injection: SQL, command, path traversal, template, log, header
- Authorization on every new/changed access path — trace from entry point to data, not just "has an attribute"
- Data isolation, where the system scopes data by user, account, or tenant: is the scope applied on every read and write in the changed path, including bulk operations and background work? Can a caller supply a scope identifier that is trusted?
- Secrets, tokens, PII in code, logs, errors, URLs, test fixtures
- Unsafe deserialization, SSRF, open redirects, insecure defaults, permissive CORS
- Input validation at the boundary versus trust deep in the stack
- Pipeline/config changes that widen access or disable a control

---

## F. Data Integrity, Persistence & Migrations

**Include when:** changes to stored data, schemas or migrations, data access code, caching, files written to disk, serialized formats, message payloads.

- Migrations: reversible? safe on large tables (locks, online-ness)? idempotent? compatible with the old code during deploy?
- Migration numbering/naming per project convention; collision with siblings in the batch
- Transaction boundaries: multi-step writes that must be atomic and are not
- Constraints and indexes for new access patterns, where the store has them; nullability matching code assumptions
- Cache invalidation and stale reads
- Backward/forward compatibility of stored and serialized formats, APIs, and messages

---

## G. Performance & Scalability

**Include when:** new data access, loops over large or unbounded collections, new hot paths, large payloads, caches, or anything run per request, per item, or per frame. Often merged with D or F.

- N+1 access, calls or queries in loops, missing indexes for new access patterns
- Unbounded growth: unpaginated reads, unbounded caches/queues, whole datasets in memory
- Accidental O(n²), repeated expensive computation
- Hot-path allocations; blocking calls on event loops, UI threads, or worker pools
- Payload size and serialization cost on chatty interfaces

---

## H. API & Contract Design (within a PR)

**Include when:** a public or shared interface changes: an API, library exports, a CLI, a message format, a plugin or extension point. Cross-PR contract *matching* belongs to A; this axis is about the quality of each surface on its own.

- Breaking changes without versioning; renamed/removed fields; changed semantics behind an unchanged name
- Inconsistency with existing conventions in the same codebase (naming, casing, error handling, paging, argument order)
- Leaky abstractions; return types that force error-prone handling at call sites
- Misleading names; optional parameters that change behaviour silently

---

## I. Maintainability & Conventions

**Include when:** the repo has documented rules (a `CLAUDE.md`, a contributing guide, convention or architecture docs) or the batch is large enough that structure matters. The spec must list the convention files to read.

- Violations of documented project rules — cite the rule
- Duplication of logic that already exists in the codebase (go look for it)
- Oversized functions or modules, deep nesting, boolean-flag parameters, dead code added
- Magic numbers/strings; copy-paste with subtle divergence
- Comments that lie or will rot; TODO/FIXME/HACK without tracking
- Violations of the module or dependency boundaries the project defines

---

## J. Testing Gaps

**Include when:** always, unless the batch is docs/config only.

- Which changed lines and branches have NO test coverage? Be specific — name functions and branches.
- Tests that assert nothing meaningful, test the mock, or would pass with the code broken (mentally mutate the code; would any test fail?)
- Missing negative, error-path, boundary, and concurrency tests
- Flakiness: time, ordering, shared fixtures, real network
- Over-mocking that hides integration bugs — especially for the cross-PR contracts from the brief
- Tests that mock away the wiring (registration, routing, dependency injection, configuration) and so cannot catch it being missing

---

## K. Operational & Deployment

**Include when:** config, feature flags, build or release scripts, infrastructure, logging, or anything that behaves differently per environment or platform.

- Config needed in other environments or on other platforms; secrets sourced correctly; environment-specific values hardcoded
- Feature flags: default, cleanup plan, behaviour when flipped while in use, consistency across components (coordinate with A)
- Release-order dependencies and rollback safety — can this be reverted cleanly after it has run?
- Logging: missing on new failure paths, noisy on hot paths, PII in logs
- Diagnostics for new failure modes (metrics, alerts, error reporting) where the project uses them
- Build or CI changes: pinned versions, permissions widened, steps skipped

---

## L. User Interface

**Include when:** the batch touches anything a person sees or operates directly: web, mobile, or desktop UI, a CLI or terminal UI, templates, styles, UI state, navigation.

- Lifecycle: listeners, subscriptions, and timers cleaned up when a view or component goes away; setup and teardown symmetric
- State: stale state after navigation, races between loading data and leaving the view, optimistic updates without rollback
- Input: validation matching what the rest of the system accepts (see the brief); disabled/loading states; double-submit
- Security: unsanitized markup, URLs or commands built from user input, tokens in storage or URLs
- Accessibility: keyboard reachability, labels, focus management, readable output for assistive tools
- i18n: hardcoded user-facing strings where the project localizes
- Error/empty/loading states rendered, not just the happy path
- Wiring: the new view or command is reachable wherever the brief says it must be (coordinate with A)

---

## M. Infrastructure, Build & Release

**Include when:** infrastructure-as-code, CI/CD definitions, build scripts, container or deployment configuration, packaging, or release settings change. Merge into K when small.

- Drift between environments or targets; per-environment settings out of sync
- Resource naming/tagging conventions, quotas, size or tier changes with cost or capability impact
- Secrets referenced from a secret store, never inline
- Permissions, triggers on the right branches, pinned versions of tools and templates
- Validation or dry-run steps present before anything is released

---

## Choosing axes — worked example

Batch of three PRs for one feature: PR 1 changes how a record is stored and adds a function that returns it in a new shape (600 lines, includes a data migration); PR 2 calls that function and passes the result on (150 lines); PR 3 shows the result to users behind a new feature flag (700 lines).

Specs, one per PR: **PR 1** — A (the new shape vs what PR 2 expects, merge order vs the migration), B, C, F, J, K; **PR 2** — A (contracts with PR 1 and PR 3), B, C, J; **PR 3** — A (the shape it receives from PR 2, the flag name), B, L, J, K. Three reviewers. Pick axes from what each PR actually changes, whatever the architecture — a single app, a library, a CLI, a set of services, or anything else.
