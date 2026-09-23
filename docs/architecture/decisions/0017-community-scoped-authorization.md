# 0017 — Community-scoped authorization: identity ceilings AND community standing; delegated capabilities; host-only moderation retired

**State: PROPOSED — design only. Nothing here is implemented; no table, endpoint, event publisher or screen exists.**

**Status:** Proposed
**Date:** 2026-09-23

**Amends** [0005](0005-authorization-architecture.md). Its mechanism (one
decision point, deny-overrides, a typed catalogue, enforcement at the edge and
in the use case) is unchanged, and **its rejection of per-resource ACLs
stands**: standing inside a community lives in the module that owns
communities, and identity's `POLICY_RULES` becomes empty. **Revises the
provisional answer of [Q1]** (decision 11). **Supersedes** the host-only
paragraph of [authorization.md §5](../authorization.md#5-resource-scoped-rules)
("Provisional rule in force: host-only moderation") once P6 lands.
Builds on [0014](0014-academic-core-v1.md), whose rule was "eligibility is a
permission; access is a relationship", and on
[0016](0016-communities-module.md). The design in full is
[communities.md §6](../communities.md#6-authorization) and
[live.md §7](../live.md#7-authorization-how-live-decides); the summary is
[the hub, §8](../communities-live-attendance.md#8-authorization-model).

## Context

The brief asks that a community's owner delegate individual powers without
handing over ownership, that a community be lockable by "teacher, owner, or
another principal with an explicitly delegated permission", and that the design
"not assume every teacher can lock every group". Its candidate names
(`group.members.invite`, `group.lock`, `group.live.moderate`, …) come with the
instruction to inspect the existing authorization system before choosing.

**What exists today:**

- Identity is role-wide RBAC. Roles resolve to 30 permissions of the shape
  `^[a-z]+[.][a-z_]+$`, enforced by a DB CHECK
  (`identity/infrastructure/schema.ts:36`). `PolicyAuthorizationService`
  decides by deny-overrides (`policy.ts:50`).
- `POLICY_RULES` is provided inside identity and not exported
  (`identity.module.ts:150`, `:181`). The only rule is `host-only-moderation`
  (`provisional-policy.ts:139-141`). It applies whenever a caller asks
  `live.moderate` with an `ownerUserId` (the room's host, as
  `moderate-speaker.use-case.ts:163-167` passes it), and then denies everyone
  else (`policy.ts:82-85`), OWNER included. `live.speak` is not covered, so
  `join-live-session.use-case.ts:85-91`, which passes `ownerUserId` only with
  `live.speak`, never triggers it. Q1's provisional answer records the rule:
  nobody but the room's host moderates, "including the owner".
- ADR 0005 rejected per-resource ACLs (`0005-authorization-architecture.md:86-88`).
- Academic and messaging already scope access as a role-wide ceiling AND a
  relationship the module owns (`academic-access.ts:68-84`;
  `conversation-access.ts:58-72`).

Most of the brief's names cannot be identity permissions: three segments
(`group.members.invite`, …) fail the CHECK. `group.lock` would pass it, but it
would still be role-wide, not "in community C".

## Decision

Everything below is proposed. None of it exists today.

1. **The rule.**

   ```
   effective(P, C, act) = identity ceiling(act)
                        AND Communities standing(P, C, act)
                        AND the lifecycle gate(status, act)
   ```

   A community grant only ever narrows what identity allows; it never adds to
   it.

2. **Identity gains four catalogue leaves, and nothing else.**
   `communities.read`, `communities.create`, `communities.moderate`,
   `communities.manage` (30 → 34), with their `PROVISIONAL_ROLE_PERMISSIONS`
   rows and data migration 0009 in the 0008 pattern. The grants are
   PROVISIONAL:
   - OWNER and ADMIN hold all four by construction;
   - TEACHER gains `read` and `moderate` ([Q44]);
   - SUPERVISOR, ASSISTANT_TEACHER and STUDENT gain `read` ([Q41]);
   - `create` is OWNER and ADMIN only ([Q41]); `manage` is OWNER and ADMIN
     ([Q43]).

   New `role.spec` invariants: `create ⇒ moderate ⇒ read`, and
   `manage ⇒ read`. `AuthorizationService`, `AuthorizationContext`,
   `Principal` and `AccountDirectory` are unchanged. `attendance.oversee` is
   not added, and no new module exercises `attendance.read` or
   `attendance.manage` (the precondition recorded under [Q31]).

3. **Communities owns a closed act vocabulary, `community.*`.**
   - Delegable capabilities: `community.members.view`,
     `community.members.invite`, `community.members.remove`,
     `community.lock`, `community.chat.post`, `community.live.start`,
     `community.live.moderate`.
   - Participation acts, satisfied only by an ACTIVE stint:
     `community.view`, `community.chat.read`, `community.live.join`,
     `community.live.raise_hand`.
   - Two derived acts: `community.live.host`, backed by
     `community.live.start`: the host's moderation of their own session; and
     `community.live.remain` (P6), staying in a running session: the ceiling
     and basis of `community.live.join`, allowed while `runningLiveContinues`
     instead of `liveJoinOpen`. Live's reconciler asks it through
     `permittedAmong` (decision 6).
   - Reserved: `community.attendance.record` and `community.attendance.view`,
     added in P9 by a CHECK migration, with ceilings that use no
     `attendance.*` permission ([Q69]); `community.messages.moderate`, until
     Q51 and Q23 are answered.

   The acts never mix with identity permissions. Most have three segments,
   which identity's shape CHECK can never accept, but **`community.view` and
   `community.lock` have two** and would match it, so segment count alone is
   not the guarantee. The separation rests on three tested guards:
   `isPermission(act)` is false for every act, no identity namespace is
   `community` (singular), and the TypeScript unions `CommunityAct` and
   `Permission` share no member, so passing an act to `AuthorizationService`
   does not compile
   ([communities.md §6.3](../communities.md#63-the-act-vocabulary)).

4. **Standing comes from four bases; the first match wins.**
   - **membership**: a participation act and an ACTIVE stint;
   - **owner**: standing OWNER on the stint, which implicitly holds every
     capability within its ceilings (PROVISIONAL, [Q42]);
   - **grant**: an ACTIVE grant keyed to the stint, so a rejoin never revives
     it;
   - **oversight**: `communities.manage`, whose reach is PROVISIONAL ([Q43]).
     It may view, list members, lock and unlock, list and revoke links, remove
     members and transfer ownership (not to oneself). It never adds members,
     creates links, reads chat, acts in live sessions or views attendance.
     Reads on this basis are audited.

5. **The act rules are one PROVISIONAL table** in `communities/domain`, not
   exported. A ceiling lists identity permissions that are all required.

   | Act (`community.` omitted) | Standing ceiling | Owner implicit | Oversight | While LOCKED |
   | --- | --- | --- | --- | --- |
   | `view` | `communities.read` | as a member | `communities.manage` | yes |
   | `members.view` | `communities.moderate` | yes | `communities.manage` | yes |
   | `members.invite` | `communities.moderate` | yes | none | no |
   | `members.remove` | `communities.moderate` | yes | `communities.manage` | yes |
   | `lock` | `communities.moderate` | yes | `communities.manage` | never blocked |
   | `chat.read` | `communities.read` + `messaging.read` (`COMMUNITY_CHAT_READ_CEILING`, P4) | as a member | none | yes |
   | `chat.post` | `communities.moderate` + `messaging.send` | yes | none | no |
   | `live.start` | `communities.moderate` + `live.moderate` | yes | none | no |
   | `live.host` | as `live.start` | as `live.start` | none | while `runningLiveContinues` |
   | `live.moderate` | `communities.moderate` + `live.moderate` | yes | none | yes |
   | `live.join` | `communities.read` + `live.join` | as a member | none | yes |
   | `live.remain` (P6) | as `live.join` | as a member | none | while `runningLiveContinues` |
   | `live.raise_hand` | `communities.read` + `live.raise_hand` | as a member | none | yes |

   The columns are answered by [Q43] (oversight), [Q44] (ceilings), [Q46]
   (LOCKED), [Q51] (posting) and [Q54] (live). Listing and revoking links is
   admitted to oversight and while LOCKED by an operation-level override
   ([communities.md §6.6](../communities.md#66-which-act-each-communities-operation-asks)).
   An answer edits this table and its pinning test; no consumer changes.

6. **One port answers.** `COMMUNITY_AUTHORIZATION.authorize(principal,
   communityId, act) → Result<CommunityPermit>`, and
   `authorizeEach(principal, communityIds ≤ 1,000, act)` for list views. A
   `CommunityPermit` names the principal, community, scope, act, basis, stint
   (`membershipId`, `joinedAt`, `version`; null only for oversight), grant
   (non-null only for the grant basis) and the ceiling held. The acting module
   copies it into its audit metadata. From P6, principal-less callers (Live's
   reconciler and `LIVE_AUDIENCE`) ask `permittedAmong(communityId, userIds
   ≤ 1,000, act) → userIds`: trusted in-process, it runs the same evaluation
   per user with the ceiling taken from `ACCOUNT_DIRECTORY.withPermission`
   instead of a `Principal`, and never takes the oversight basis. No consumer
   keeps a copy of the act rules.

7. **Evaluation invariants.**
   - For a principal, ceilings are checked in memory **before any read**. If
     neither the standing nor the oversight ceiling is held: `forbidden
     identity.permission_denied`, and nothing is read.
   - One statement on the primary reads status, stint and grant.
   - No basis and no ACTIVE stint: `not_found communities.community_not_found`,
     identical to a missing community. No basis but a member: `forbidden
     communities.capability_required`.
   - The lifecycle gate refuses with `precondition_failed
     communities.community_locked`, and never blocks `community.lock`.
   - Stateless: no cache across requests. A store failure rejects; callers
     fail closed with 503 and never fall back to a role-only answer.
   - System principals never have a stint.
   - Every mutation authorized by a capability re-verifies its basis under
     lock (the actor's stint and grant `FOR SHARE`).

8. **Delegation (P3).** The owner alone grants and revokes; there is no
   sub-delegation (PROVISIONAL, [Q44]). No escalation: the grantor must
   effectively hold the capability, and the grantee must be an ACTIVE member,
   not the owner, and hold every ceiling permission. No self-grant (a CHECK).
   Grants do not expire; a lost ceiling makes a grant dormant, not deleted;
   the owner sees every grant and each holder their own (PROVISIONAL, [Q45]).
   A non-owner may remove a member only if that member's grants, dormant ones
   included, are a subset of the remover's effective capabilities, and never
   the owner (PROVISIONAL, [Q44]).

9. **Ownership.** Standing on one ACTIVE stint; exactly one owner. The owner
   cannot leave or be removed while owner. Transfer is made by the owner, or by
   a `communities.manage` holder to an eligible ACTIVE member other than
   themself, as demote-then-promote in one transaction. The new owner's grants
   end; the old owner becomes MEMBER with none. All PROVISIONAL ([Q42]).
   `communities.moderate` is the single ceiling for ownership and for every
   delegable capability.

10. **Live moderation, and the end of `host-only-moderation`.** Holders of
    `community.live.moderate` moderate any session of the community. The
    session's host, who started it, moderates their own session while
    `community.live.host` holds. Delegated moderators act only on participants
    who are not the host. No identity role, OWNER included, moderates without
    community standing, and there is no institution-wide override (PROVISIONAL,
    [Q54]). `PROVISIONAL_POLICY_RULES` becomes `Object.freeze([])` **in the
    same change (P6)** that ships Live's `LiveAccess` and stops passing
    `ownerUserId`. `restrictToResourceOwner` and `ownerOfResourceRule` stay in
    `policy.ts` with their specs; the all-permission-principal refusal test
    moves to Live ([live.md §7.4](../live.md#74-retiring-host-only-moderation)).

11. **Q1's provisional answer is revised**, and stays provisional. From: "May
    anyone other than a room's host moderate it? Provisionally no one,
    including the owner." To: **the session host, while
    `community.live.host` holds, and holders of `community.live.moderate` in
    that community; no identity role, OWNER included, moderates without
    community standing.** Q1 and [Q54] stay open.

12. **ADR 0005's rejection of per-resource ACLs stands.** Identity gains no
    per-community grant, no scoped role, no three-segment permission and no
    `PolicyRule` from another module. Resource standing lives in the owning
    module, as academic and messaging already do.

## Consequences

If accepted:

- A TEACHER without standing in a community can do nothing there: not lock,
  invite, start, moderate or record. A grant in one community gives nothing in
  another. P2 pins this with a refusal matrix.
- Revocation takes effect on the next request, because there is no cache to
  invalidate on any node. A decision is an in-memory ceiling check plus one
  statement on two unique indexes: O(1) in community size.
- Identity stays ignorant of communities, and the Nest graph stays acyclic.
- Migration 0009 would break the academic upgrade test, which migrates to the
  latest migration and asserts an exact grant delta
  (`academic-postgres.spec.ts:580`). P0 pins it to its own migrations first
  ([0021](0021-cross-cutting-rules-for-new-modules.md)).
- OWNER and ADMIN cannot moderate a live session in a community where they
  have no standing. That keeps today's position on Q1 for the institution's
  roles, while delegation inside a community becomes possible.
- A future identity DENY rule (a legal hold, a safeguarding block) can match a
  community act, because ceilings are checked with the context
  `{resourceType: 'communities.community', resourceId, attributes: {act}}`.
- Every act is attributable: the permit, with its basis, stint and grant, is
  in the acting module's audit entry.
- Retiring the rule and shipping `LiveAccess` must land together. Retiring it
  first would let any `live.moderate` holder moderate any room; shipping
  `LiveAccess` first would leave the veto refusing every delegate.

## Alternatives considered

- **Per-community grants inside identity**: scoped roles, a grants table, or
  per-community permission sets on `Principal`. Rejected: it reverses ADR 0005,
  teaches identity what a community is, and makes `Principal` grow with every
  membership.
- **Communities contributes `PolicyRule`s to identity.** Rejected: rules are
  synchronous and see only what the caller supplies, so they cannot look up
  grants; a `permit` rule lets a module grant itself power; `POLICY_RULES` is
  internal (`identity.module.ts:150`); and wiring a Communities provider into
  identity closes a Nest cycle.
- **Three-segment identity permissions** (`group.members.invite` in the
  catalogue). Rejected: it changes the CHECK, its unit test and the one-level
  flatten, and the answer is still role-wide.
- **Unprefixed act names** (`live.moderate`, `attendance.view`). Rejected:
  `live.moderate` is already an identity permission (`permissions.ts:85`), so
  passing an act to `AuthorizationService` would type-check and return the
  unscoped role answer.
- **Five names and shapes for the one question** "may P do this in C": a
  standings batch, a permit, a principal-less standing, a three-valued check,
  and an internal gate, each from a different part of an earlier draft of this
  design. Rejected for one contract (decision 6), whose principal-less
  `permittedAmong` runs the same evaluation. The three-valued answer maps as
  granted = ok, denied = `forbidden
  communities.capability_required`, not found = `not_found
  communities.community_not_found`.
- **A boolean `holds(userId, communityId, capability)`.** Rejected: it cannot
  tell 404 from 403, and without the `Principal` it cannot evaluate oversight.
- **A permit value object with a `permitted` flag** instead of `Result`.
  Rejected: it breaks the `Result` convention of `authorize()`,
  `ConversationAccess.member` and `AcademicAccess`, and every consumer would
  have to remember to branch on it.
- **Hard-coded community roles** (OWNER / MANAGER / TEACHER / MEMBER), or a
  MANAGER column on membership. Rejected: they freeze policy into code, invent
  roles the brief asks not to invent, and cannot express "this one power
  only". A client may offer presets that expand into individual grants.
- **Owner authority tied to `communities.create`.** Rejected for one ceiling,
  `communities.moderate`, for ownership and every delegable capability; the
  invariant `create ⇒ moderate` keeps every creator eligible.
- **`communities.create` also for SUPERVISOR and TEACHER**, mirroring
  `messaging.create_group`. Rejected as the provisional default for spaces of
  up to 30,000 minors ([Q41]). Teachers run communities by delegation: under
  Q41's PROVISIONAL default an OWNER or ADMIN creates the community and grants
  `members.invite`, `lock`, `live.start` and `live.moderate`, or transfers
  ownership to an eligible teacher. The brief asks only that an owner can
  delegate without handing over ownership (§3).
- **Oversight limited to roster view and ownership recovery.** Rejected for
  the wider provisional reach in decision 4, which follows messaging's
  precedent that `messaging.manage` removes but never adds ([Q23], [Q43]).
- **`attendance.oversee`, and attendance ceilings on `attendance.read` /
  `attendance.manage`.** Rejected: it exercises unscoped grants that the Q31
  precondition says must be scoped through `ACADEMIC_RELATIONSHIPS` or left
  unexercised, breaks the exact grant-delta test, and puts oversight in one
  consumer ([0020](0020-attendance-snapshots.md)).
- **`members.view` ceiling = `communities.read`.** Rejected: an owner could
  hand a roster of up to 30,000 minors to a student. The conservative default
  is `communities.moderate` ([Q44]).
- **The owner holds only governance capabilities; activity needs an audited
  self-grant.** Rejected: ceremony that adds an audit row and no control, and
  conflicts with the no-self-grant CHECK.
- **The starter has no moderation power** (attribution only). Rejected: it
  drops the host concept Q1 already has, and the brief (§9) expects a teacher
  who may start to moderate speakers and end the session.
- **Host moderation = host AND still a member.** Rejected: an owner could not
  stop a host mid-session short of removing them. Tying it to
  `community.live.start` gives the owner that lever.
- **Leave `host-only-moderation` registered but inert** (stop passing
  `ownerUserId`). Rejected: a registered, tested rule that production never
  applies is a trap; any future caller passing `ownerUserId` re-activates the
  OWNER veto, and Q1 would change by accident.
- **Generalise the rule** (for example a co-host list in the context).
  Rejected: it keeps resource standing in identity, fed by lists callers
  compute, and it still fails open when no context is supplied.
- **Cache decisions** in tokens, the `Principal` or a TTL cache; give
  moderators LiveKit `roomAdmin`. Rejected: revocation must take effect on the
  next command, and media-plane authority cannot be revoked reliably on the
  open-source LiveKit server ([0019](0019-community-scoped-live-sessions.md)).
- **Derive standing from `ACADEMIC_RELATIONSHIPS.isTeaching`.** Rejected: it
  would answer Q36 and Q31 by construction, and it ignores whether a halaqa is
  closed (Q32). It remains a possible capability-source seam ([Q50]).
- **Removal that locks only the target.** Rejected: two delegates could remove
  each other concurrently, or one could act while their grant is being
  revoked. Decision 7 re-verifies the actor's basis under lock.
- **Grants as an array on the stint, or keyed by (community, user).**
  Rejected: no per-capability unique index or history, a write to a hot row
  per grant, and stale grants revived on rejoin.
- **Deny system principals outright.** Rejected: identity's model is that a
  system principal holds exactly what it is given. It never has standing.
- **`community.messages.moderate` in v1.** Rejected: no messaging act would
  check it. Reserved until [Q51] and [Q23].

[Q1]: ../open-questions.md#q1--what-may-each-role-actually-do
[Q23]: ../open-questions.md#q23--moderation-deletion-and-review
[Q31]: ../open-questions.md#q31--teaching-scope-and-what-staff-may-see
[Q41]: ../open-questions.md#q41--what-is-a-community-and-who-may-create-one
[Q42]: ../open-questions.md#q42--community-ownership
[Q43]: ../open-questions.md#q43--institutional-oversight-of-communities
[Q44]: ../open-questions.md#q44--who-may-hold-delegated-capabilities
[Q45]: ../open-questions.md#q45--capability-grants-duration-handover-and-visibility
[Q46]: ../open-questions.md#q46--what-does-locked-mean-and-who-may-lock
[Q50]: ../open-questions.md#q50--communities-and-the-academic-structure
[Q51]: ../open-questions.md#q51--the-community-chat-who-may-post
[Q54]: ../open-questions.md#q54--who-starts-ends-and-moderates-a-live-session
[Q69]: ../open-questions.md#q69--who-records-and-who-views-snapshots
