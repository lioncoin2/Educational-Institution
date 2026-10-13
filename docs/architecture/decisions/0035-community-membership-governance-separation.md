# 0035 — Community membership governance: enrollment, membership and capabilities stay separate (owner decision)

**Status:** Accepted — 2026-10-13 (owner decision, Sprint 32). **Supersedes the *open/deferred*
status of [ADR 0034](0034-q50-enrollment-sourced-membership-and-derived-capabilities.md):** the Q50
question ADR 0034 left open is now answered. This ADR records the policy; it changes no production
code, schema, migration, contract, role, or capability — the existing implementation already enforces it.

## Context

[ADR 0034](0034-q50-enrollment-sourced-membership-and-derived-capabilities.md) (Sprint 30)
investigated enrollment-sourced community membership and derived capabilities and **deferred** them,
because the policy was not owner-approved and two model gaps would make them unsafe. [ADR 0033](0033-community-halaqa-link-and-member-list-visibility.md)
had already made the optional community→halaqa link **inert** (metadata only). The owner has now
decided the policy direction (Sprint 32), which resolves the open question **in the direction the
existing design already assumes**: keep the concepts separate.

## Decision (owner policy A–E)

- **A — Academic enrollment does not create or remove community membership.** Enrolling a student in
  a halaqa is an academic relationship; linking a community to a halaqa is an organizational
  association only. Neither adds a student to a community; neither removes a student when enrollment
  ends. Membership changes only through the explicit, authorized community member-addition flow or the
  invitation flow.
- **B — Authorized supervisors control member addition.** Member addition stays on the existing
  authorized management/invitation flows. No enrollment-based membership flow is introduced. Who may
  discover, invite, add, remove, or manage is **not broadened** — the existing owner/admin/supervisor
  and per-community `community.members.invite` / `communities.manage` boundaries stand.
- **C — Membership source stays explicit.** `MEMBERSHIP_SOURCES` remains exactly `['ADDED','INVITATION']`.
  No academic-enrollment / `SYSTEM` / derived source is added (automatic academic membership is not
  approved), and the two existing sources are never merged.
- **D — Membership and administrative capabilities are separate.** Ordinary membership (a MEMBER
  stint) grants no capability; capabilities follow only explicit owner delegation. Removing a
  membership affects only that community's stint and the grants bound to it; it never touches another
  community's membership or grants. No independent grant is revoked because a membership ended.
- **E — Preserve module separation.** Academic enrollment, community membership, invitations,
  capability grants, attendance, and messaging stay separate; no coupling is introduced without an
  explicit future policy + ADR. No speculative abstraction, migration, flag, or background job is added.

## How the existing implementation already satisfies this (verified in source)

- **A.** `academic` imports no `communities` code (dependency-cruiser + `communities-boundaries.spec`);
  community membership is changed only by Communities' own use-cases. Nothing consumes academic's
  enrollment events to mutate membership. Regression-tested in `communities.api.spec` (enrolling a
  student in a linked halaqa adds no member; ending the enrollment removes no explicit member).
- **B.** `AddMembersUseCase` / `RedeemInvitationUseCase` re-authorize `community.members.invite` (or the
  link) on every call; `GET /communities/:id/member-candidates` is gated per-community (ADR 0032). No
  route was added or widened.
- **C.** `communities/contracts/vocabulary.ts` `MEMBERSHIP_SOURCES = ['ADDED','INVITATION']`; the schema
  CHECK `community_members_source_valid` enforces it. `memberStint` sets `standing:'MEMBER'`; `ownerStint`
  `standing:'OWNER'`.
- **D.** A grant is bound to one stint by the composite FK `(membershipId, communityId, userId)` and
  "gives nothing in another community" (`grant.ts`; `delegation.spec.ts`). Removal/leave ends **only that
  stint's** grants with reason `membership_ended` (`in-memory-community-store.ts`,
  `drizzle-community-repository.ts`). A newly-added MEMBER has `capabilities: []`
  (`communities.api.spec`). **There is no independent-of-membership grant concept**, so there is nothing
  to wrongly revoke — the existing `membership_ended` semantics are exactly Policy D, and **no new
  revocation rule is invented or needed** (the ADR 0034 §Policy-D caveat is resolved: the model *can*
  distinguish — every grant belongs to exactly one stint in one community).
- **E.** Module boundaries are CI-enforced (`.dependency-cruiser.cjs`, the per-module `*-boundaries.spec`).
  The one approved cross-module edge is communities→`academic/contracts/relationships` for the inert
  link's existence check (ADR 0033) — read-only, no membership/capability effect.

## Consequences

- **Q50 is now fully resolved.** The optional halaqa link is inert metadata (ADR 0033); enrollment-sourced
  membership and derived capabilities are **not built, by owner decision** (this ADR) — permanently,
  unless a future owner decision + ADR reopens them. The two model migrations ADR 0034 sketched are **not**
  made (Policy C/D forbid the derived sources they were for).
- No schema/migration/contract/role/capability/UI change. ADR 0023 (attendance), ADR 0032, and ADR 0033
  are unchanged and consistent with this.
- Future flexibility is preserved by the separation itself: a later "enrollment may inform membership"
  policy, if ever approved, would be additive (ADR 0034 records the design) — but it is explicitly **out
  of scope and not approved** now.

Reconciliation: ADR 0034 remains the immutable investigation record; this ADR supersedes only its
*status* (the question is answered). The governance prerequisites ADR 0034 cited (Q40/Q36/Q35/Q69,
ADR 0015/0016) were already resolved (see register §19/§20).
