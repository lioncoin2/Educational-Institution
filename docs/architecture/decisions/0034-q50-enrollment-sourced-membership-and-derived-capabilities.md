# 0034 — Q50: enrollment-sourced community membership and derived capabilities

**Status:** Deferred — the policy is not owner-approved; Q50 remains **OPEN**. This
ADR records the investigation, why implementation is not safe yet, the exact
decisions the owner must make, and the design to use once they do. It decides
only to **not build** the behaviour now, and to lock the current inert behaviour
in with a regression test.

**Date:** 2026-10-13

## Context

[0033](0033-community-halaqa-link-and-member-list-visibility.md) (Sprints 28–29)
shipped the optional, **inert** community→halaqa link with real existence
validation. Two Q50 parts were explicitly left open: **enrollment-sourced
community membership** and **capabilities derived from academic relationships**.

Sprint 30's mission was to determine whether these can be implemented **safely
within the existing architecture** — not to invent the institutional policy. The
investigation traced the real source, not names or docs.

### Evidence (traced from source, 2026-10-13)

| Question | Source-of-truth evidence | Current behaviour | Decision status |
| --- | --- | --- | --- |
| Which enrollment states qualify as "current"? | `academic/contracts/vocabulary.ts` `ENROLLMENT_STATUSES = ['ACTIVE','COMPLETED','WITHDRAWN']`; `enrollment.use-cases.ts` `EnrollStudentUseCase` (creates ACTIVE), `EndEnrollmentUseCase` (COMPLETED/WITHDRAWN). No future/scheduled state; an ended enrollment is never reopened (a new one is made). | ACTIVE = current; COMPLETED/WITHDRAWN = history. | **Unresolved** — policy must say which states confer membership. |
| Can a person hold several concurrent enrollments / assignments? | `EnrollStudentUseCase` docstring + `academic_enrollments_active_unique` (one ACTIVE per *student+halaqa*, not per student). | Yes — multiple concurrent ACTIVE enrollments across halaqat are allowed. | **Unresolved** — multi-enrollment → multi-community membership policy. |
| Is a "move"/transfer modelled? | `EndEnrollmentUseCase` docstring: a placement correction / support move / ضخ / merge is "neither (Q37)… not recorded through this until Q37 is answered." | No transfer/reactivation lifecycle; only enroll + end. | **Unresolved** — blocked on Q37. |
| Which community receives the membership? | `communities/infrastructure/schema.ts` nullable `halaqa_id`, **no uniqueness** (ADR 0033): community→0..1 halaqa, halaqa→0..n communities. | A halaqa may back several communities; a community may link ≤1 halaqa. | **Unresolved** — "which community / several / none" is undecided (see B below). |
| Does membership distinguish a system/derived source? | `communities/contracts/vocabulary.ts` `MEMBERSHIP_SOURCES = ['ADDED','INVITATION']`; schema CHECK `community_members_source_valid`. | **No** derived/system source exists. | **Unresolved + model gap** — needs an additive migration. |
| How are manual memberships preserved if a derived source ends? | `membership.use-cases.ts` / `in-memory-community-store` — one ACTIVE stint per person (`community_members_current_unique`); end is REMOVED/LEFT, source-blind. | Not representable: a stint has one `source`, and there is one ACTIVE stint per person. | **Unresolved + model gap**. |
| How are capabilities derived / how do independent sources coexist? | `communities/domain/grant.ts` — a grant is "given by the owner" (R5, `grantedBy ≠ holder`); `GRANT_END_REASONS = ['revoked','membership_ended','ownership_changed']`; schema `communities_capability_grants_active_unique` on `(membershipId, capability)`. | **One active grant per stint+capability, owner-delegated, no `source` field.** A derived + a manual grant of the same capability cannot coexist. | **Unresolved + model gap** — needs an additive migration; and the capability↔relationship mapping is undefined. |
| How are retries / reconciliation handled? | `platform/events/event-bus.ts` `InProcessEventBus` (synchronous, in-memory, fire-after-commit, best-effort — "no durable outbox"); academic emits `academic.student.enrolled` / `.enrollment_ended` etc. with **zero consumers** (`academic/contracts/events.ts`); the `CommunityChatSync` + `CommunityChatSweeper` + reconciler pattern (messaging) projects membership from events via wake→pull-contract→idempotent-apply→sweeper. | Events are non-durable; no outbox; a proven reconciliation pattern exists but nothing writes community membership from outside communities. | **Available** — infra is ready; no new infra needed. |

## Decision

**Do not implement enrollment-sourced membership or derived capabilities. Q50
stays OPEN.** Three independent reasons, each sufficient:

1. **The policy is not owner-approved.** The open-question's provisional default
   is explicitly *"no link, no enrollment-sourced membership and no derived
   capabilities in v1,"* and [0032](0032-discovery-membership-attendance-separation.md)
   rejects deriving membership from enrollment as *"exactly Q50, which is OPEN;
   building it would invent the institutional policy this ADR is forbidden to
   invent."* It is also gated behind Q36, [0015](0015-academic-structure-reconciliation.md)
   and the Q40 governance gate. Building it would invent policy.

2. **The data model cannot do it safely even if approved.** Membership has no
   derived `source`, so a derived membership could not be told apart from a
   manual one — ending enrollment could not remove *only* the derived source
   while preserving a manual membership (a Sprint-30 hard requirement). Capability
   grants are owner-delegated, single-active-per-stint+capability, with no
   `source` — a derived grant and an independent manual grant of the same
   capability cannot coexist, so revoking the derived one could strip
   authorization an independent source still justifies. Shipping revocation on
   this model would be unsafe. Both need **additive migrations** first.

3. **No capability mapping exists.** Which capability follows from which academic
   relationship is undefined in source and ADRs; inventing one is forbidden.

What *is* ready: the propagation infrastructure. No outbox or broker is needed —
the established `CommunityChatSync` pattern (wake on an event, **pull** the
current truth from a contract, apply idempotently with a monotonic cursor, and a
boot+interval **sweeper** that heals lost/duplicate/reordered wakes) already
delivers the reliability the non-durable bus lacks.

### Exact decisions the owner must make (narrowed by the evidence)

- **A. Eligibility.** Does an ACTIVE enrollment confer membership? What happens on
  COMPLETED / WITHDRAWN (remove derived membership? keep as alumnus?)? (Transfer
  is blocked on Q37.)
- **B. Target & cardinality.** Membership into the community(ies) linked to the
  enrolled halaqa — but a halaqa may back **several** communities (ADR 0033). All
  of them? none-until-exactly-one? And a halaqa with **no** linked community:
  no-op, or blocked? (Do not change ADR 0033's cardinality.)
- **C. Ownership/coexistence.** Confirm derived membership is a **distinct source**
  that coexists with and never overrides a manual membership — requires the
  membership-source migration below.
- **D. Capabilities.** The exact capability↔relationship mapping (if any), and
  that an independent manual grant must survive revocation of a derived one —
  requires the grant-source migration below. Membership must not imply any
  capability without an explicit rule.
- **E. Consistency.** Confirm asynchronous projection (wake + pull + sweeper) is
  acceptable (it is the repo's norm) rather than a synchronous cross-module write
  (which the module boundaries forbid — academic may not write communities).

### Design to use once approved (readiness, not a commitment)

- A `CommunityAcademicSync` in **communities**, mirroring `CommunityChatSync`:
  subscribe (via the existing `EVENT_SUBSCRIBER`) to academic's enrollment events
  as **wake-ups only**; pull current truth from `ACADEMIC_RELATIONSHIPS`
  (`isEnrolled` / `activeStudentIds`, already public); project membership
  idempotently; back it with a boot+interval sweeper/reconciler. No new
  infrastructure, no outbox, no broker, no scheduler framework.
- **Migration 1 (membership source):** add a derived value (e.g. `SYSTEM`) to
  `MEMBERSHIP_SOURCES` + the `community_members_source_valid` CHECK (additive;
  journal + snapshot; Flutter enum), so derived and manual stints are
  distinguishable and independently removable.
- **Migration 2 (grant source):** add a `source` to `communities_capability_grants`
  (and relax the active-unique index to per-source), **only if** derived
  capabilities are approved — so an independent manual grant survives revocation
  of a derived one.
- Authorization stays evaluated from authoritative current state through the one
  community authorizer; membership never implies a capability by itself.

### Rejected now

- **Implement it this sprint.** Rejected: invents unapproved institutional policy
  (reasons 1 & 3) and would ship unsafe revocation on an inadequate model
  (reason 2).
- **Add a transactional outbox / broker / scheduler.** Rejected: unnecessary — the
  existing wake+pull+sweeper pattern already provides idempotent, self-healing
  propagation; the brief forbids speculative infrastructure.
- **Synchronous academic→communities write.** Rejected: wrong ownership and a
  forbidden cross-module internal write; academic is a pure producer.

## Consequences

- Q50's membership/capability parts remain **OPEN**; the owner has a precise,
  evidence-backed decision sheet (A–E) and a ready design, so answering "yes"
  later is additive.
- The current **inert** behaviour is now locked by a cross-module regression test
  (`communities.api.spec` — enrolling a student in a linked halaqa creates no
  membership; `memberCount` unchanged; the enrolled non-member is told the
  community does not exist), alongside the ADR 0033 inert-link tests.
- No schema, migration, contract, role, capability, or Flutter change was made.
  ADR 0023 (attendance) and ADR 0033 (the halaqa link's cardinality and inert
  behaviour) are unchanged.

This ADR **supersedes none**. It refines [0016](0016-communities-module.md)
dec. 11 by recording the concrete readiness (the `CommunityChatSync` pattern) and
the two model gaps that any future implementation must close first.
