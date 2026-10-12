# 0033 — Optional community–halaqa link, conversation member-list visibility, and the current-student roster

**Status:** Accepted
**Date:** 2026-10-12

## Context

Three owner-approved decisions (Sprint 28), implemented as far as the actual
architecture safely supports. They are recorded together because they were
approved together and share one guiding principle: a relationship, or an
association, confers only what it is explicitly defined to confer — never
membership, capability, or authorization by implication (the separation
[0032](0032-discovery-membership-attendance-separation.md) already names).

The owner's full rulings and the source/test map are in
[`owner-decision-register.md` §17](../../owner-decision-register.md). This ADR
records the decisions and — for Q50 — the one architectural trade-off that had
to be surfaced rather than guessed.

## Decision

### 1. A community may be optionally associated with one academic halaqa (Q50) — inert metadata

A community MAY carry an optional academic halaqa association. The association
**derives nothing**: it creates and removes no membership, grants and revokes no
capability, and yields no messaging, attendance, academic or role authority.
Explicit membership mutations and the existing academic authorization stay the
only sources of their respective truths. No enrollment→membership SYNC source,
no derived-capability source, no background job, and no implicit invitation is
built — consistent with [0016](0016-communities-module.md) dec. 11, which listed
all three as *not built in v1*.

- **Storage.** A nullable `communities.halaqa_id` column (migration `0021`,
  additive `ADD COLUMN`, data-safe). It is **not** a foreign key: academic owns
  `academic_halaqat`, and no module holds a database constraint on another
  module's tables (communities.md §17; the same rule in every module's schema).
  There is **no** uniqueness constraint, so one halaqa may back any number of
  communities. This is the **smallest cardinality model that imposes no
  institutional rule**: community → 0..1 halaqa, halaqa → 0..n communities. A
  cardinality rule (e.g. one community per halaqa) would be an institutional
  decision; none is imposed.

- **Management authority.** `SetCommunityHalaqaUseCase` is gated on the existing
  identity permission `communities.manage` — "institutional oversight of
  communities one does not belong to … never adding members, never reading
  chats". It is held only by the owner and admins, who also hold
  `academic.manage`, so the one authority cleanly spans *both* sides (the
  community and the academic reference) without inventing a capability or role.
  The link is deliberately **not** modelled as a community *act/operation*, so
  the `me` block, `COMMUNITY_OPERATIONS`, and the capability counts are
  untouched. Routes: `PUT /communities/:id/halaqa` (set) and
  `DELETE /communities/:id/halaqa` (clear); edge permission `communities.read`
  as on every community route, with the use case deciding on `communities.manage`
  (the established "coarse edge, use-case decides" pattern,
  [0017](0017-community-scoped-authorization.md)). The act is audited
  (`communities.halaqa.linked` / `communities.halaqa.unlinked`) and emits no
  domain event — nothing may react to it, by the inert rule.

- **The one surfaced trade-off: existence validation vs. the module boundary.**
  [0016](0016-communities-module.md) dec. 11 anticipated validating the
  referenced halaqa "through `ACADEMIC_RELATIONSHIPS`." That is now **prohibited
  by a CI-enforced invariant**: Communities depends on *no* other business module
  — academic included — only on identity's contracts (communities.md §17,
  enforced by `test/architecture/communities-boundaries.spec.ts`). Since the link
  derives nothing, a stale reference is **inert and harmless**. We therefore
  validate the reference for **shape only** (a non-empty opaque id) and **defer**
  cross-module existence validation. Resolving it later is an owner/architect
  choice among:
  1. **Amend the isolation boundary** to permit `communities → academic/contracts`
     (weakens §17; a deliberate architectural reversal, recorded in its own ADR).
  2. **Introduce a dependency-inversion seam** — a port Communities owns
     (`communities/contracts/`), implemented outside both modules and wired at the
     composition root — so Communities still imports no academic code.
  3. **Keep it unvalidated** (accept inert, possibly-stale references as the
     metadata-only cost of the boundary).

  In Sprint 28 we did not pick for the owner; we shipped the inert link and
  documented the decision. **Sprint 29 resolved it by option 1** — see the
  update below.

- **Client.** Flutter's `Community` model carries `halaqaId` (inspect). In
  Sprint 28 the link/unlink UI control was a documented deferred entry point.
  **Sprint 29 built it** (see the update below); the server
  (`PUT`/`DELETE …/halaqa`, `communities.manage`) remains the single enforcement
  point regardless.

### 2. A conversation's member list is owner/admin only (Q22)

Only the institution **owner and top-level administration** may read a
conversation's participant list. This boundary is cleanly expressible in the
existing model, so no new role or permission is created: `users.manage` is held
by OWNER and ADMIN only (never a supervisor, teacher, assistant-teacher, student
or parent) and is already the repository's canonical "is an administrator" test.

`ListParticipantsUseCase` requires `users.manage` — the single, server-side
enforcement point, applied uniformly across DIRECT, GROUP and CHANNEL
conversations (the former channel-only rule is subsumed). Taking part in a
conversation, owning it, publishing to a channel, teaching, or managing a
community grants **no** access to the roster. The member-list concern is
distinct from reading messages, sending, and managing participants — each
decided on its own and unchanged here. Community-chat rosters remain refused on
this route; they are Communities' (`community.members.view`). The existing
membership precondition is kept, so the change only narrows access and adds no
new non-member reach.

### 3. The teacher roster is current students only (Q31)

A teacher's roster is the halaqa's **current** (ACTIVE) students. **Former**
enrollments (COMPLETED, WITHDRAWN) are an academic administrator's view
(`academic.manage`), never reached through a teaching assignment. The enrollment
model has no "future" state — an enrollment is ACTIVE from the moment it is made
— so there is nothing future to exclude. `ListHalaqaStudentsUseCase` refuses a
non-ACTIVE status filter (`academic.historical_roster_denied`) to a caller
without `academic.manage`; the default ACTIVE roster — a teacher's ordinary call
— is unchanged. Historical records are preserved and the separately-authorized
administrator workflow is intact. This corrects the roster to the previously
approved academic-discovery contract; it uses only the existing enrollment
statuses and invents no enrollment rule.

## Consequences

- The optional community–halaqa link exists as inert metadata and can be
  inspected; it still sources no membership, capability, or authorization —
  those questions (enrollment-sourced membership, derived capabilities) remain
  *not built*, by design.
- Communities remains isolated from academic at the module boundary; the
  existence-validation decision is deferred and explicit, not silently resolved.
  *(Superseded by the Sprint 29 update below: now validated through academic's
  read-only relationships contract.)*
- The conversation member list is an administrative view; normal messaging
  (reading, sending, managing participants) is unaffected.
- Teachers see current students; administrators retain the full historical view.

This ADR **supersedes none** of [0016](0016-communities-module.md),
[0017](0017-community-scoped-authorization.md),
[0023](0023-attendance-authorization-and-policy.md) (attendance — untouched), or
[0032](0032-discovery-membership-attendance-separation.md). It refines
[0016](0016-communities-module.md) dec. 11 by recording how the anticipated
`ACADEMIC_RELATIONSHIPS` validation is realised. No role grant, `people.read`,
messaging capability, or attendance rule was changed.

## Update — Sprint 29 (2026-10-13): existence validation and the management UI

Sprint 28 left two things open for this ADR: cross-module existence validation
(deferred) and the Flutter management control (deferred). Sprint 29 completed
both, keeping everything else above true.

**Existence validation — resolved by option 1 (the port contract).** A link's
target is now validated server-side before it is stored: a new read-only
`halaqaExists(halaqaId)` on academic's **public** `ACADEMIC_RELATIONSHIPS`
contract (implemented in academic from its own repository) answers existence
only — never an enrollment, a teaching assignment, a name or a roster.
`SetCommunityHalaqaUseCase` calls it and refuses a dangling reference with
`communities.halaqa_not_found` (404) before persisting; unlinking (null) needs
no check.

This is the brief's preferred design and is **architecture-legal**: the
cross-module dependency rule (`dependency-rules.md`, `.dependency-cruiser.cjs`)
has always held that *only* a module's `contracts/` directory is public, and
communities now depends on academic through that contract **alone** — never its
internals, its `application`, or its tables. It is **acyclic** (academic depends
on identity only; nothing in academic imports communities). The module-specific
`communities-boundaries.spec.ts` was the only thing stricter than the
architecture rule — it asserted communities knew *no* other business module,
a statement whose premise ("no halaqa link, Q50") the owner reversed by approving
the link. That test was amended **surgically** to permit exactly the one edge
(`academic/contracts/relationships` + wiring `AcademicModule`) and nothing more;
every other isolation assertion (no academic tables, no internals, pure domain)
still holds. Options 2 (a dependency-inversion seam) and 3 (leave unvalidated)
were not taken: option 1 is simpler, uses the repository's standard
consumer-imports-provider DI, and makes the now-approved coupling honest and
visible rather than hiding a real runtime dependency behind an inverted port.

**Management UI — built.** The server now surfaces the authority as
`me.canManageHalaqa` (computed from `communities.manage`, true for the owner and
admins alone) — a UI courtesy, never the authorization. The community management
surface shows the current association (resolved to the halaqa's name through the
academic catalogue), and, to a holder of `me.canManageHalaqa`, a link/change
control (a halaqa picker that reuses the existing catalogue — sections →
programs → halaqat, structure only, no student or teacher) and an unlink control
(after confirming). The link mutates no membership; the server decides again on
every request. `me.canManageHalaqa` is additive to the `me` block — it is **not**
a community operation, so `COMMUNITY_OPERATIONS` and the capability/operation
counts stay unchanged.

Still **not built**, by design and still OPEN: enrollment-sourced membership and
derived capabilities. Migration 0021 is unchanged; no new migration was needed.
