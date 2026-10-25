# 0044 — Community role policy revision: who starts broadcasts, who adds members, and how ownership is recovered

**Status:** Accepted — 2026-10-25 (owner decision, "Approved Policy Revision & Trial Backend Delivery",
decisions A, B, C; register §30). **Supersedes in part** the PROVISIONAL defaults of
[Q1](../open-questions.md#q1--what-may-each-role-actually-do) (the supervisor's live row),
[Q42](../open-questions.md#q42--community-ownership) (who transfers, and the "no recovery" line),
[Q43](../open-questions.md#q43--institutional-oversight-of-communities) (oversight's transfer),
[Q44](../open-questions.md#q44--who-may-hold-delegated-capabilities) (the supervisor as a delegate) and
[Q54](../open-questions.md#q54--who-starts-ends-and-moderates-a-live-session) (who passes the start
ceiling), and [ADR 0035](0035-community-membership-governance-separation.md) decision B ("not broadened").
Every other line of those records stands.

## Context

The owner approved three changes to the community role policy and asked that every one be enforced by the
server, with the general institutional role never standing in for a missing community-level permission.
The audit (2026-10-25) found the capability model already carried the shape the owner described — a
community act needs an identity **ceiling** *and* a community **basis** (owner standing or a delegated grant
in that community, ADR 0017) — so the change is to *who passes the ceiling* and to *one transfer rule*,
not a new mechanism.

## Decision

**A — Starting a broadcast.** The owner, teachers, administration and supervisors may start a broadcast
**according to the permission the community gives them**: the community's owner standing, or a
`community.live.start` grant in that community. The identity ceiling for live hosting (`live.moderate`,
with `live.speak` to publish by right) is now held by OWNER, ADMIN, SUPERVISOR and TEACHER. A general role
with no community basis is refused (`403 live.start_not_permitted` for a member, the not-found answer for a
non-member) — the institution's own OWNER included; there is still no institution-wide override (Q54).
ASSISTANT_TEACHER and STUDENT stay outside the ceiling (`403 identity.permission_denied`), and a grant to
them is refused (`422`). Speaking (`live.speak`) and screen-sharing (Q56, ADR 0028) stay distinct
permissions: nothing here changes who may share a screen.

**B — Adding members.** Authorized teachers, administrators and supervisors may add members only to the
groups and channels they are permitted to manage there — the community's owner standing or a
`community.members.invite` grant — through the existing member-addition and invitation flows (ADR 0035 A/C
unchanged: no enrollment-based membership, sources stay `ADDED`/`INVITATION`). The identity ceiling for
delegated capabilities (`communities.moderate`) is now held by OWNER, ADMIN, SUPERVISOR and TEACHER, so a
supervisor *can be granted* the capability; without the grant they are refused
(`403 communities.capability_required`). Oversight (`communities.manage`) still never adds (Q43).
Validation stays the server's: an unknown or ineligible account is `422 communities.members_not_eligible`,
an existing member is answered idempotently, another community's grant never carries.

**C — Ownership.** The creator becomes the initial owner (unchanged). Ownership changes only through an
explicit, authorized transfer: by the owner, or — the one administrative **recovery** path — by a
`communities.manage` holder **only when the current owner can no longer act**: their account is not
ACTIVE, or they no longer hold the ownership ceiling (`communities.moderate`). While the owner can act,
oversight is refused (`403 communities.owner_can_still_act`): a general institutional role never silently
replaces an owner. `me.operations` lists `community.ownership.transfer` to an overseer exactly when that
recovery would be allowed, so the app and the route agree. Legacy data: the audit found no community
without an ACTIVE owner on Trial and none can be created by the application; a community whose owner row is
missing is answered as not found by the store and is reported, never repaired silently, and nothing is
deleted.

**Migration.** `0032_supervisor_live_and_community_ceilings` (data only, additive): `role_permissions` gains
SUPERVISOR × `live.speak`, `live.moderate`, `communities.moderate`. No schema change; reverting is deleting
those three rows.

## Consequences

- Supervisors are now *eligible* for live hosting and for delegated community capabilities; what they may
  do in a given community is still that community's grant — nothing is granted by this ADR.
- Tests: `test/api/community-role-policy.api.spec.ts` (A/B per role, positive and negative, cross-community,
  duplicate, invalid target), `role.spec.ts` (the ceilings), communities `delegation.spec.ts` and
  `me-operations.spec.ts` (recovery only when the owner cannot act; never for oneself),
  `communities.api.spec.ts` (transfer refused while the heir is active, allowed once suspended),
  `communities-postgres.spec.ts` (the same recovery on Postgres; `ownersOf` parity in the contract suite).
- Still open: the rest of Q1's role matrix; whether a recovery should also be possible for an owner who is
  merely absent (not suspended) — not approved, so not built.
