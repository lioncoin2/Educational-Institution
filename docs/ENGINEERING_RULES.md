# Engineering Rules

**Status: authoritative and permanent.** These are the project-wide engineering
rules every change obeys. They are not a style preference and not reversible per
task: unlike the institutional decisions in
[`project-checkpoint.md`](project-checkpoint.md) (which are current and
reversible), these rules hold across phases and modules until deliberately
amended here in a dedicated change.

**Read this before implementing anything.** Every implementation task — by
Claude Code or anyone — begins by reading this file and
[`project-checkpoint.md`](project-checkpoint.md), and proceeds only in a way
these rules allow. When a rule here and a specific architecture document or ADR
both apply, they are meant to agree; if they ever disagree, that is a conflict to
**stop and resolve** (see [§16](#16-adr--documentation-discipline) and
[R9](#the-non-negotiable-rules)), never to paper over.

This document governs *how* we build. It does not restate *what* each module is
(that is [`architecture/module-boundaries.md`](architecture/module-boundaries.md)),
*which* dependency edges are forbidden (that is
[`architecture/dependency-rules.md`](architecture/dependency-rules.md), executable
in `backend/.dependency-cruiser.cjs`), or *why* a hard-to-reverse choice was made
(that is [`architecture/decisions/`](architecture/decisions/)). It points at
those and makes the discipline around them mandatory.

---

## 1. The mandatory workflow

Every implementation task follows this sequence, in order. Skipping a step is a
process violation, not a shortcut.

```
INSPECT
  → UNDERSTAND ARCHITECTURE
  → IDENTIFY RESPONSIBILITY OWNER
  → IDENTIFY DEPENDENCY BOUNDARIES
  → PLAN FILES
  → DEFINE CONTRACTS
  → DEFINE TESTS
  → IMPLEMENT
  → VERIFY
  → REVIEW DIFF
  → UPDATE DOCS/ADR IF REQUIRED
  → COMMIT
```

- **INSPECT** — read the current code and the relevant docs. Do not infer the
  system from memory or from a previous conversation; re-read the actual files
  you will touch.
- **UNDERSTAND ARCHITECTURE** — know the layer model
  ([§4](#4-domainapplicationinfrastructureapi-separation)) and how the module in
  question already works before adding to it.
- **IDENTIFY RESPONSIBILITY OWNER** — decide which existing owner the behavior
  belongs to, or that a new owner is warranted ([§5](#5-responsibility-ownership-and-cohesion), [R1](#the-non-negotiable-rules), [R2](#the-non-negotiable-rules)).
- **IDENTIFY DEPENDENCY BOUNDARIES** — know which modules/layers may be reached
  and in which direction ([§3](#3-architecture-dependency-direction-and-module-boundaries)).
- **PLAN FILES** — decide the exact files to create/modify and why each one is
  the right home ([§5](#5-responsibility-ownership-and-cohesion)).
- **DEFINE CONTRACTS** — settle the public surface (types, ports, routes,
  failures) before the implementation that fills it ([§6](#6-contract-first-development)).
- **DEFINE TESTS** — state the test matrix the change must satisfy before writing
  the code that passes it ([§10](#10-test-strategy-and-non-vacuous-architecture-tests)).
- **IMPLEMENT** — write the minimal correct code for the defined scope, and
  nothing else ([R5](#the-non-negotiable-rules), [R6](#the-non-negotiable-rules)).
- **VERIFY** — run the full validation gate ([§15](#15-definition-of-done-and-mandatory-validation-before-commit)).
- **REVIEW DIFF** — read the whole diff and confirm it contains only the intended
  change.
- **UPDATE DOCS/ADR IF REQUIRED** — record any decision or boundary change
  ([§16](#16-adr--documentation-discipline)).
- **COMMIT** — one focused commit, only after the gate is green.

Plan-before-implement is required for any non-trivial change: a read-only plan
(files, contracts, tests, risks, owner decisions) comes first, and real
conflicts are surfaced rather than guessed ([R3](#the-non-negotiable-rules),
[R4](#the-non-negotiable-rules)).

---

## 2. Software-engineering discipline (no vibe coding)

- **Build toward the final architecture directly.** No throwaway versions, no
  "we'll clean it up later." The standing principle in
  [`project-checkpoint.md`](project-checkpoint.md) ("Engineering principles") is
  binding.
- **No vibe coding.** Every change has a stated reason, a known owner, a defined
  contract, and tests. Code is not added because it "seems to work" or because a
  location is convenient; it is added because it is correct and belongs there.
- **Read like the surrounding code.** Match the established idioms, naming,
  layering, comment density and test style of the module you are in. A new file
  that does not look like its neighbors is a smell.
- **Correctness is reported faithfully.** If a check fails, say so with the
  output. Do not describe work as done until it is verified
  ([§15](#15-definition-of-done-and-mandatory-validation-before-commit)).

---

## 3. Architecture, dependency direction and module boundaries

The system is a **modular monolith** (ADR 0002): one process, hard internal
boundaries, modules that could be extracted later. The rules below are enforced
in CI by dependency-cruiser (ADR 0009) and the `test/architecture/*` specs; this
section makes the *intent* mandatory so the executable rules are never worked
around.

- **Dependency direction is inward.** `api → application → domain`, and
  `infrastructure → domain`. Nothing points outward. The domain depends on
  nothing — not Nest, not Drizzle, not LiveKit, not Node libraries — and declares
  **ports** that infrastructure implements as **adapters**
  (`domain-is-dependency-free`, `domain-does-not-look-outward`).
- **The `contracts/` directory is a module's only public surface.** Another
  module sees `contracts/` and nothing else. No module imports another module's
  `domain/`, `application/`, `infrastructure/` or `api/`
  (`no-cross-module-internals`), and **no module reads another module's database
  tables — ever** (overview.md §4).
- **Modules talk in this order of preference:** events (something happened,
  others may care), then contracts (a synchronous answer the caller needs now),
  then read models (a module builds its own projection rather than querying
  foreign tables). See [`architecture/events.md`](architecture/events.md).
- **No circular dependencies** (`no-circular`), and **no `forwardRef`** to escape
  one: a cycle is a boundary error to fix, not to annotate.
- **Vendor SDKs live behind a port, in infrastructure only.** A third-party SDK
  (LiveKit, a WebSocket library, a push SDK, an ORM) is confined to the one
  module's `infrastructure/` that owns that port, never in `domain/`,
  `application/` or `api/` (the `*-only-in-the-*-adapter` rules).
- **The shared kernel stays pure.** `src/shared/` holds only domain-neutral
  primitives (Id, Result, Clock, DomainEvent, Principal) and imports no npm
  package (`shared-kernel-is-pure`, `shared-kernel-has-no-npm`). `platform/`
  knows no module (`platform-knows-no-modules`).

If a change seems to require breaking one of these edges, that is a design
problem to raise ([R8](#the-non-negotiable-rules)), not a rule to suppress.

---

## 4. Domain / application / infrastructure / api separation

Each module is layered, and each layer has a single kind of responsibility:

| Layer | Owns | Must not |
| --- | --- | --- |
| `domain/` | Entities, value objects, invariants, pure functions, and ports | Import any framework, adapter, or npm package; perform I/O |
| `application/` | Use cases: orchestration, authorization, transactions, mapping observations to domain input | Touch adapters or the HTTP layer (`application-does-not-touch-adapters`); contain entity invariants that belong in the domain |
| `infrastructure/` | Adapters implementing ports (DB, RTC, storage, clock, ids); schema and migrations | Hold business rules or decide authorization |
| `api/` | HTTP edge: controllers, DTOs, guards, response mappers | Contain business logic; import `domain/` internals (`api-does-not-touch-domain-internals`); reach adapters (`api-does-not-touch-adapters`) |
| `contracts/` | The module's public types, tokens, events | Depend on the module's internals (`contracts-are-self-contained`) |

**API / controller boundary.** A controller only transports input and formats
output: it reads the principal and params, calls one use case, and maps the
`Result` to the wire. It decides no access and runs no business rule. One use
case per action; no `XService` god object. A controller sources the types it maps
from the application layer, never from `domain/`.

---

## 5. Responsibility ownership and cohesion

- **Single Responsibility Principle.** Each file/class has one reason to change.
  A use case does one act; an adapter implements one port; a mapper maps one
  shape.
- **One authoritative owner per behavior** ([R2](#the-non-negotiable-rules)).
  A rule, calculation or decision is implemented once, in the layer and module
  that owns it. Other layers and modules consume it through its boundary; they do
  not re-derive or duplicate it. **No duplicated business rules.**
- **Responsibility must not accumulate.** Before adding substantial code to an
  existing file, decide whether the responsibility actually belongs there
  ([R1](#the-non-negotiable-rules)). A file is not a convenient drawer; adding to
  it is a deliberate choice that its cohesion survives.
- **No God files / God services.** A file that has grown many unrelated
  responsibilities is decomposed by cohesion. File-size guidance (from the
  standing checkpoint principles): **100–300 lines preferred, 300–500 ok,
  500–700 review, >700 decompose, >1000 prohibited unless explicitly justified**
  — split by cohesion, never artificially to hit a number.
- **No dumping-ground files** ([R7](#the-non-negotiable-rules)). Do not create
  `utils.ts`, `helpers.ts`, `common.ts`, `misc.ts` or a module-local `shared.ts`
  as a home for unrelated odds and ends. A shared helper lives with the
  responsibility it serves, or — only when it is genuinely domain-neutral and
  justified — in the architected shared kernel `src/shared/` (which has its own
  enforced purity, [§3](#3-architecture-dependency-direction-and-module-boundaries)).
  The existence of `src/shared/` and `platform/` is not licence to invent ad-hoc
  catch-alls.
- **Optimize for correct boundaries, not for fewer files**
  ([R6](#the-non-negotiable-rules)). More small, cohesive files are better than
  one large file that merges responsibilities.

---

## 6. Contract-first development

- **Define the contract before the implementation.** For a new or changed public
  surface, settle the types, ports, routes and failure codes first, then fill
  them. The near-empty `contracts/index.ts` of an unbuilt module is a deliberate,
  cheap commitment to a boundary (overview.md §2).
- **A contract is self-contained** and is the only thing other modules import.
- **Vertical-slice implementation.** Build a feature as a thin, complete slice
  through the layers — domain → application → infrastructure → wiring → api →
  tests — each slice small, verified and committed on its own, rather than a
  wide horizontal layer at a time. Contracts and ports come before the code that
  consumes them.

---

## 7. Authorization ownership

- Authorization is **centralized** (ADR 0005) and, for community-scoped acts,
  **community-scoped** (ADR 0017): identity ceilings AND community standing.
- A consumer module never re-implements an access decision. It wraps the
  authority behind a single, named per-module gate (the established pattern:
  `LiveAccess`, `ConversationAccess`, `AttendanceAccess`) that asks
  `COMMUNITY_AUTHORIZATION` / identity and maps the answer to the module's own
  refusals. The gate is the one place that decision lives.
- **The edge is never the decision.** A route declares the access level it needs
  (the architecture test requires exactly one: public, authenticated, or a
  permission — `test/architecture/authorization.spec.ts`), and the use case asks
  the authority again, in context. A client-supplied id, role or name is a claim
  nobody trusts.
- A module does not invent a new catalogue permission to dodge the proper
  authority, and does not exercise an unscoped permission a decision record has
  reserved for another owner.

---

## 8. Error taxonomy

- Use cases return `Result<T>` and never know HTTP. A failure is
  `failure(kind, code, message, details?)` where `kind` is one of the fixed
  `FailureKind` union: `not_found`, `forbidden`, `unauthenticated`, `conflict`,
  `validation`, `precondition_failed`, `rate_limited`, `unavailable`.
- **One place maps a failure to HTTP:** `platform/http/http-failure.ts`
  (`unwrap` → `FailureException`, `STATUS_BY_KIND`). Controllers call `unwrap`;
  they do not choose status codes. Adding a new `FailureKind` is a compile error
  there until it is mapped, so transport semantics cannot drift from domain
  semantics.
- Codes are stable, namespaced strings (`<module>.<reason>`) chosen for the
  client, and are covered by tests. Masking rules (e.g. a forbidden resource that
  must read as "not found") are deliberate and tested, not accidental.

---

## 9. Database and migration discipline

Follows [`architecture/persistence.md`](architecture/persistence.md):

- Tables are private to their module. **Plain cross-module id columns, no
  cross-module foreign keys**; in-module FKs only. CHECK constraints mirror domain
  invariants. Keyset indexes for list reads.
- Every persistent port has an **in-memory twin** so the module runs and is
  tested without a database; the twin and the real adapter keep the same
  guarantees.
- **Migrations are append-only and sequentially numbered**, taking the next free
  number; a committed migration is never edited. Schema changes are additive
  where possible.
- **Never run a seed or migration against a production or shared database** as
  part of development. Validate schema/migration work on an **isolated,
  ephemeral** Postgres only. A schema or migration change is out of scope for a
  task that did not explicitly ask for it; if one turns out to be unavoidable,
  stop and report it ([R8](#the-non-negotiable-rules)).
- The repository port is a contract: do not change its shape casually. Reads
  never reach across module boundaries.

---

## 10. Test strategy and non-vacuous architecture tests

- **Tests are mandatory.** The pyramid: pure **domain** tests (no I/O);
  **use-case** tests with fakes for every branch and refusal; **adapter** tests
  (the in-memory twin always; the real adapter against an ephemeral Postgres for
  the integration suite); **API E2E** through the real app and `configureApp`;
  and **architecture** tests.
- **Match the house test convention.** Controllers and DTOs are exercised through
  API E2E, not bespoke unit specs, unless the module already does otherwise. Add
  tests the way the module already tests.
- **Architecture tests must be non-vacuous.** A rule that cannot fail proves
  nothing. Every forbidden dependency-cruiser rule must be demonstrably able to
  fire — `test/architecture/rules-match.spec.ts` pins each rule's matcher against
  the graph for exactly this reason. When you add or change an architectural
  rule, prove it can both pass on the real graph and fail on a violation. A known
  non-firing rule (overview.md §5 records one) is a documented defect to fix, not
  a precedent to copy.
- A test asserts real behavior. No test is written merely to raise a coverage
  number or to assert a tautology.

---

## 11. Security

- **No secrets outside configuration** (`no-secrets-outside-config`). Secrets come
  from config/env, never hard-coded, logged, or sent to another service.
- **The client is never trusted for authority.** Identity, community, host and
  counts are the server's to know; a client sends only its own inputs (an
  idempotency key, a cursor). The Flutter app holds no secrets and receives only
  short-lived, capability-scoped tokens.
- **No PII where it does not belong.** Account ids, not names or emails, cross
  contracts; names are resolved at view time; emails never appear in a response,
  event, audit entry or log line. Historical-data integrity matters: immutable
  records stay immutable.
- Fail closed: when the authority or store cannot answer, refuse (503), never
  compute an answer from roles alone.

---

## 12. Observability

Follows [`architecture/observability.md`](architecture/observability.md):

- Significant actions are **audited** through the `AuditLog` port, with the
  authority the act ran on in the metadata — and never participant/PII payloads.
- Logs are structured, carry correlation ids, and never carry secrets or PII.
  Failures are logged with their code and metered; they are not audited as
  business rows.
- Health and metrics endpoints exist for operability; new long-running or
  external work is observable.

---

## 13. Performance

- Respect the **measured and provisional bounds** a module documents (page-size
  caps, in-flight limits, deadlines, room/session caps). Do not raise a cap
  without the measurement the module says calibrates it.
- List reads are keyset-paginated with a clamped limit; they do not load
  unbounded sets. Hot paths do not hold locks across external calls.
- **Correctness first, then measured performance.** No micro-optimization that
  obscures intent, and no performance claim that has not been measured
  (overview.md §6).

---

## 14. Avoiding premature abstraction, unnecessary dependencies, and scope creep

- **No premature abstraction.** Introduce an abstraction when there is a second
  real consumer or a proven boundary, not in anticipation. A port exists because
  something external must be swapped or faked, not for its own sake.
- **No unnecessary dependencies or technologies.** Adding an npm package, a vendor
  SDK, or a new piece of infrastructure is a decision with a cost; it is
  justified, confined behind a port in one adapter, and — when hard to reverse —
  recorded in an ADR. Prefer what the repository already uses.
- **Scope discipline.** A task does exactly what it asked for. No feature,
  endpoint, abstraction, or refactor beyond the stated scope rides along
  ([R5](#the-non-negotiable-rules), [R10](#the-non-negotiable-rules)).

---

## 15. Definition of Done, and mandatory validation before commit

A change is **done** only when all of the following hold. Running them is
mandatory **before every commit**, and a commit happens only when they pass; if
anything fails, do not commit — report the failure and stop.

- [ ] **Architecture checks** pass — `test/architecture/*` (`npm run test:arch`).
- [ ] **Dependency / import checks** pass — dependency-cruiser (`npm run arch:graph`), no new forbidden edge, no `forwardRef`, no cross-module internal import.
- [ ] **Unit tests** pass — domain and use-case suites for the changed module.
- [ ] **Integration / E2E tests** pass where applicable — API E2E through `configureApp`; the Postgres integration suite on an ephemeral database for adapter/schema work.
- [ ] **Typecheck** clean — `npm run typecheck`.
- [ ] **Lint** clean — `npm run lint`.
- [ ] **Formatting** clean — `npm run format` / `format:check`.
- [ ] **Diff reviewed** — the whole diff read; it contains only the intended change.
- [ ] **`git diff --check`** clean — no whitespace errors or conflict markers.
- [ ] **No unrelated changes** — nothing outside the task's scope was modified ([R10](#the-non-negotiable-rules)).
- [ ] **Documentation / ADR updated when required** — a decision, boundary, contract or invariant change is recorded ([§16](#16-adr--documentation-discipline)).
- [ ] **Working tree clean** after the single focused commit.

`npm run verify` (`format:check && lint && typecheck && arch:graph && test`) is
the aggregate gate; module-scoped runs are acceptable during iteration, but the
relevant gates above must be green before the commit. Pushing and merging are
separate, human-authorized steps — never part of "done" unless explicitly asked.

---

## 16. ADR / documentation discipline

- **Decisions that are expensive to reverse are recorded as ADRs**
  ([`architecture/decisions/`](architecture/decisions/)): Context → Decision →
  Consequences → Alternatives.
- **An ADR is immutable.** It is never edited to change its decision; a new ADR
  supersedes it (wholly, or "in part") and the old one keeps its text and gains
  only a status/pointer line. The record is the history, not the current state.
- **Keep the source-of-truth current.** When a change alters a module's remit, a
  boundary, a contract, or the roadmap state, update the owning architecture
  document and [`project-checkpoint.md`](project-checkpoint.md) in the same
  change. Do not let docs drift from the code.
- **No silent architectural change** ([R9](#the-non-negotiable-rules)). If an
  implementation conflicts with an ADR, a contract, a dependency rule, a schema
  boundary, or an established invariant: **stop, document the conflict, and
  resolve it explicitly** — by changing the plan, or by a new ADR that supersedes
  the old one with the owner's agreement. Never rewrite an ADR's decision to make
  a conflict disappear.

---

## The non-negotiable rules

These are stated plainly so they can be cited by identifier in reviews and plans.

- **R1 — Responsibility before convenience.** Before adding substantial code to
  an existing file, determine whether the responsibility actually belongs to that
  file. Do not allow files to become accumulation points for unrelated
  responsibilities.
- **R2 — One authoritative owner.** Every significant behavior has one
  authoritative owner. Other layers consume that behavior through an explicit
  boundary; they do not duplicate or reimplement it.
- **R3 — Investigate when unsure.** If the correct architectural location is
  unclear, stop and investigate. Do not choose a convenient location merely
  because it is faster.
- **R4 — Surface conflicts.** Stop and report real conflicts and contradictions
  rather than guessing or silently resolving them.
- **R5 — No scope creep.** A focused task does only what it asked for.
- **R6 — Boundaries over file count.** Do not optimize for fewer files; optimize
  for correct responsibility boundaries and cohesion.
- **R7 — No dumping grounds.** Do not create generic catch-all files
  (`utils.ts`, `helpers.ts`, `common.ts`, `misc.ts`, a local `shared.ts`) unless
  the responsibility is genuinely domain-neutral and justified.
- **R8 — Right location, not convenient location.** If the correct place for code
  (a layer, a module, a port) is architecturally elsewhere, put it there — even if
  a nearer file is faster. A persistence/port/boundary change that a task did not
  ask for is stopped and reported, not slipped in.
- **R9 — No silent architectural changes.** A conflict with an ADR, contract,
  dependency rule, schema boundary or invariant is stopped, documented and
  resolved explicitly — never silently rewritten.
- **R10 — No unrelated refactoring during a focused task.** Clean-ups and
  renames outside the task are proposed separately, not bundled in.
- **R11 — No knowing temporary hacks.** Do not introduce a "temporary" workaround
  that is knowingly left for later cleanup. Build the correct thing, or stop and
  raise the blocker.
