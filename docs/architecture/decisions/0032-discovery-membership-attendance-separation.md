# 0032 — People discovery is not membership, authorization, or attendance

**Status:** Accepted
**Date:** 2026-10-12

## Context

People discovery, community membership, and academic attendance are three
separate concerns, and the system keeps them separate. A search result is only a
minimal identity (`{userId, displayName}`) offered so a person can act — it is
not proof of membership, enrollment, a teaching assignment, or attendance
eligibility, and it confers nothing.

Sprint 24 (commit `03fd925`) made the discovery surfaces least-privilege and
recorded the owner's ruling in the decision register
([`owner-decision-register.md` §15](../../owner-decision-register.md)). Confirmed
against the current source:

- **`GET /people`** — the institution-wide directory, gated on the identity
  permission `people.read`, which OWNER/ADMIN hold only (supervisors and teachers
  no longer hold it — data-only migration `0020`). It is a membership-management
  lookup, not a general directory for all staff.
- **`GET /communities/:communityId/member-candidates`** — the add-member
  picker's search, authorized per community on the delegable community capability
  `community.members.invite` through the one community authorizer
  (`CommunityAuthorizationService` — never `communities.manage`, since oversight
  never adds). It reuses identity's relationship-blind, ACTIVE-only
  `ACCOUNT_SEARCH` and discloses the same minimal `{userId, displayName}`.
- **The add itself** remains the explicit `POST /communities/:communityId/members`
  mutation (`AddMembersUseCase`), which independently re-authorizes
  `community.members.invite` and re-checks each account's eligibility.

This ADR formalizes the separation that this implementation already embodies, so
a future change cannot quietly conflate the three. It changes no behavior.

It relates to [0016](0016-communities-module.md) (Communities owns membership
and its mutations), [0017](0017-community-scoped-authorization.md)
(community-scoped authorization: identity ceilings AND community standing, the
delegable-capability model), and [0023](0023-attendance-authorization-and-policy.md)
(attendance authorization). It **supersedes none of them**: it adds a
cross-cutting boundary, it does not replace a decision.

## Decision

1. **Discovery is not membership.** Finding an account does not add it to a
   community. A membership change is only the explicit
   `POST /communities/:communityId/members` mutation, with its server-side
   authorization (`AddMembersUseCase` → `community.members.invite`) and its
   per-account eligibility re-check. No read path adds a member.

2. **Discovery is not authorization.** A search result confers no role,
   capability, messaging permission, attendance entitlement, or any other access
   right. A candidate list is never a permission grant; no code may treat an
   account's appearing in a result as evidence of what it may do.

3. **Community-scoped search stays community-scoped.** Institution-wide
   `GET /people` is restricted to OWNER/ADMIN (`people.read`). Community candidate
   discovery requires `community.members.invite` **in the specific community being
   queried**. These authorizations are distinct from the mutation's: the eventual
   membership mutation re-checks its own authorization, and **search authorization
   and mutation authorization are not interchangeable** — passing one does not
   imply the other.

4. **Academic relationships stay independent.** Community membership and
   community capabilities are never derived from halaqa enrollment or teaching
   assignments. Per-halaqa roster authorization — a teacher reads a roster only
   through an ACTIVE assignment (Q31) — is unchanged. Attendance authorization
   stays exactly as [0023](0023-attendance-authorization-and-policy.md) decided
   (academic relationship AND community standing); **this ADR introduces no new
   attendance rule**.

5. **The open questions stay open.** This ADR does not resolve, directly or
   indirectly:
   - **Q50** — whether a community links to a halaqa, sources its membership from
     enrollment, or derives capabilities from teaching assignments: **OPEN**.
   - **Q22** — who may see a conversation's member list: **OPEN**.

   It invents no institutional policy; it records only the separation the shipped
   code already enforces.

## Consequences

**Good.**
- Discovery, the membership mutation, and attendance authorization are three
  clearly separated decisions with three distinct authorization checks — each can
  be reasoned about and changed without entangling the others.
- A search result cannot become a privilege. Accidental escalation through "they
  showed up in a list," or through a derived academic relationship, is closed off
  by construction.
- The mutation boundary carries its own authorization, so a bug or a widening in
  discovery cannot, by itself, add a member or grant access.
- Least privilege: the global directory is owner/admin only; a community manager
  reaches only their own community's candidates.

**Constraints / tradeoffs.**
- Every membership change pays a second, explicit authorization check at the
  mutation even though the caller already passed the search authorization. This
  is deliberate — the two checks are independent, not redundant.
- A teacher who owns or is delegated `community.members.invite` in a community
  discovers candidates there through the community-scoped route, not the global
  directory; there is no cross-halaqa academic student search (none was built,
  and this ADR adds none).
- `GET /people` remains an owner/admin institution-wide lookup; narrowing who may
  discover people further, or any broader directory, is a separate owner decision
  (the GROUP A remainder in the register), not settled here.

## Alternatives considered

- **One global `GET /people` for all staff, gated only by a role permission.**
  Rejected (Sprint 24): a role-granted institution-wide directory exposes every
  account's identity to any staff member — a safeguarding risk for minors (Q22,
  Q31) — and conflates "may look up a person" with "manages this community's
  membership."
- **Scope add-member discovery by academic relationship (a teacher searches their
  own halaqa's students).** Rejected as the community add-member mechanism: it
  would couple community discovery to academic enrollment and pre-empt Q50. The
  per-halaqa roster already serves that read under its own (Q31) authorization;
  community discovery is authorized by community membership authority instead.
- **Let a successful candidate search stand in for the add authorization.**
  Rejected: discovery and mutation are different decisions; collapsing them would
  let any widening of search silently widen who can change membership.
- **Derive membership from enrollment (a SYNC source) now.** Rejected: that is
  exactly Q50, which is OPEN; building it would invent the institutional policy
  this ADR is forbidden to invent.
