# 0016 — Communities: a new module owns communities, membership, invitation links and lifecycle

**State: PROPOSED — design only. Nothing here is implemented; no table, endpoint, event publisher or screen exists.**

**Status:** Proposed
**Date:** 2026-09-23

Adds a module; **supersedes nothing**. **Amends**
[module-boundaries.md](../module-boundaries.md), which gains a `communities`
section when this is accepted. Builds on [0002](0002-modular-monolith.md)
(modular monolith), [0005](0005-authorization-architecture.md) (permissions +
policy), [0006](0006-event-architecture.md) (events),
[0008](0008-drizzle-over-prisma.md) (Drizzle) and
[0014](0014-academic-core-v1.md) (academic, whose patterns it reuses). Who may
do what inside a community is [0017](0017-community-scoped-authorization.md);
the community chat is [0018](0018-community-chat-projection.md).
**Implementation is gated** by
[academic-reconciliation.md §13](../academic-reconciliation.md#13-minimal-recommended-changes-before-the-next-milestone)
([Q40]; decision 12). ADR 0015 stays reserved for the academic structure
change. The design in full is [communities.md](../communities.md); the package
hub is [communities-live-attendance.md](../communities-live-attendance.md).

## Context

The brief asks for "groups": persistent communities that exist for months or
years, hold up to 30,000 members (a number that must be able to rise and must
not become a database ceiling), admit people through invitation links, can be
locked, and whose owner can delegate powers without handing over ownership. A
group is not a LiveKit room, and 30,000 members is not 30,000 live
participants. The brief rules out messaging owning group membership, academic
owning generic group infrastructure, and a god service.

**What exists today** (commit `9670c47`):

- No module owns such a thing. Messaging owns conversation membership: one row
  per (conversation, user) that also carries read state, with caps of 500 for
  `GROUP`, 10,000 for `CHANNEL` and 200 per request
  (`messaging-policy.ts:20-27`).
- Academic owns sections, programs, halaqat, enrollments and teaching
  assignments ([0014](0014-academic-core-v1.md)) and imports only
  IdentityModule (`academic.module.ts:76`).
- Live's `LiveRoom` is bound to a halaqa and has a single host
  (`live-room.ts:10-18`).
- Every mechanism this design needs is already in the code: history rows under
  a partial unique index (academic), a member count kept in the same
  transaction (messaging), transaction-scoped advisory locks (academic), and
  the audit-then-event journal (`academic-journal.ts:11-39`).

Two constraints come from outside the brief:

- **The word.** "Group" already names messaging's `GROUP` conversation type
  (`messaging/contracts/vocabulary.ts:11`), and it is the word used for
  Tahajji's «مجموعة» in [Q36], which is unanswered.
- **The gate.** §13 of the academic reconciliation says that *before any new
  module*, Q35 and Q36 must be answered and ADR 0015 must land
  (`academic-reconciliation.md:483-493`); the Attendance hold stands
  (`academic-reconciliation.md:19-21`). Both are the user's constraints, and
  their wording is unqualified.

## Decision

Everything below is proposed. None of it exists today.

1. **The aggregate is a Community, not a Group.** Module `communities`,
   aggregate `Community`, id `communityId`, routes `/communities/...`, tokens
   `COMMUNITY_*`, events `communities.community.*`, realtime frames
   `community.*`, acts `community.*`, and messaging's link column
   `conversations.community_id`. "Group" already means messaging's `GROUP`
   conversation type and is the word used for Tahajji's «مجموعة» in Q36; using
   it would collide with the first and pre-answer the second. "Group" stays the
   brief's product word only. A community has no `kind`.

2. **Wiring.** CommunitiesModule imports IdentityModule only and exports only
   contract tokens: `COMMUNITY_AUTHORIZATION`, `COMMUNITY_MEMBERSHIP`,
   `COMMUNITY_DIRECTORY` and, from P3, `COMMUNITY_CAPABILITY_HOLDERS`. Event
   names and payload types live in `communities/contracts/events.ts`
   (`CommunityEvents`). `communities/contracts` imports only `src/shared` and
   `identity/contracts/permissions.ts`, never the identity barrel. Communities
   never imports messaging, live, attendance, realtime, notifications or
   academic. Modules that need it depend on it and pull decisions from it
   ([0018](0018-community-chat-projection.md),
   [0019](0019-community-scoped-live-sessions.md)).

3. **The community row.** `communities`: id, title, status,
   `lifecycle_version`, `membership_version`, `member_count`, `created_*`,
   `status_changed_*`. There is no owner column (ownership is standing on a
   stint, [0017](0017-community-scoped-authorization.md)), no kind and no
   halaqa id.

4. **Membership is one row per stint.** `community_members` holds one row per
   stay: status `ACTIVE | LEFT | REMOVED`, standing `OWNER | MEMBER`, source
   `ADDED | INVITATION`, `added_by`, `invitation_id`, `joined_at`, `ended_*`,
   `version`. The database holds the invariants:
   - a partial unique index: at most one ACTIVE stint per (community, user);
   - a partial unique index: at most one OWNER per community;
   - a CHECK: the owner's stint is ACTIVE;
   - `UNIQUE (community_id, version)`.

   A rejoin is a new stint. History is never overwritten.

5. **Membership is an ordered, resumable changefeed, with no ceiling.** Every
   change allocates commit-ordered versions from
   `communities.membership_version` under the community row lock, and moves
   `member_count` in the same transaction. This is the technique of
   `conversations.last_sequence` ([0011](0011-messaging-v1.md)).
   `COMMUNITY_MEMBERSHIP.changesSince` reads the feed. No request path runs
   `count(*)` or loads a whole community: every read is a point lookup, a
   keyset page, the counter or the feed. **No member limit is policy**:
   `member_count` has no upper CHECK, and a limit, if one is ever decided, is
   nullable Communities configuration enforced in the same conditional UPDATE
   ([Q20]). The only bounds are technical: 200 ids per add request, 200 per API
   page, 1,000 per contract page.

6. **Invitation links.** The token is 32 random bytes, base64url, shown once in
   the 201 response. Only its SHA-256 is stored, under a unique index. Its
   state is derived when it is used, with precedence REVOKED > EXPIRED >
   EXHAUSTED > ACTIVE; only revocation is stored. Redemption is
   `POST /communities/join {token}`, with the token in the body and never in a
   path or query, in one READ COMMITTED transaction of conditional UPDATEs
   under a per-pair advisory lock. It is idempotent for an existing member (200,
   no use consumed), linearizable against `max_uses`, revocation and lock, and
   never creates an account ([Q2]). The terms are PROVISIONAL ([Q48]):
   - an expiry is required: default 7 days, maximum 30 days, minimum 5 minutes;
   - `maxUses` is optional;
   - joining is immediate, for signed-in accounts holding `communities.read`;
   - redemption re-checks that the link's creator still holds
     `community.members.invite`, and fails if not.

   A person whose latest stint is REMOVED cannot rejoin by link; a manager may
   re-add them directly (PROVISIONAL, [Q49]).

7. **Lifecycle: OPEN ⇄ LOCKED.** Lock and unlock are idempotent commands that
   set an absolute state and answer 200. A repeat writes no audit entry and
   publishes nothing. `lifecycle_version` rises by one per real change, only so
   consumers can discard stale events. ARCHIVED is deferred ([Q47]). A
   community is never deleted: there is no delete route, and foreign keys are
   `RESTRICT`.

8. **What LOCKED means is one table, owned here.** `statePermits(status, act)`
   inside `COMMUNITY_AUTHORIZATION` answers acting principals;
   `CommunityHead.effects` (`LifecycleEffects`) answers principal-less
   consumers. Consumers see act refusals (`communities.community_locked`) and
   effect flags, never the raw status. The table is PROVISIONAL ([Q46]):

   | Status | `acceptsMembers` | `chatReadable` | `chatPostingOpen` | `liveStartOpen` | `liveJoinOpen` | `runningLiveContinues` |
   | --- | --- | --- | --- | --- | --- | --- |
   | OPEN | yes | yes | yes | yes | yes | yes |
   | LOCKED | no | yes | no | no | yes | yes |
   | unrecognised | no | no | no | no | no | yes |

   While LOCKED, links are suspended: neither consumed nor revoked, valid
   again after unlock unless expired or revoked. No new links are created.
   Management continues: unlock, view members, revoke links, remove members.
   An unrecognised status closes every new action, leaves management open, and
   ejects nobody from a running session. The gate never blocks unlocking. Who may lock is
   [0017](0017-community-scoped-authorization.md).

9. **One global lock order.**
   1. per-pair advisory locks, sorted by user id;
   2. the invitation row;
   3. existing stint rows, in ascending id;
   4. grant rows;
   5. the community row, last of the existing rows: its UPDATE allocates
      versions and moves `member_count`;
   6. new stint inserts.

   Grant, revoke and transfer never touch the community row. No transaction
   takes `FOR SHARE` on a row and then updates it.

10. **One use case per act, one journal.** Create, get, list; lock, unlock;
    add, remove, leave; list members; create, list and revoke invitations;
    redeem; and, in P3, grant, revoke and transfer. `CommunitiesJournal` writes
    the audit entry, then publishes the event, after commit, and neither on a
    no-op ([0021](0021-cross-cutting-rules-for-new-modules.md)). Events carry
    ids, codes and versions only; `member.added` and `member.removed` carry
    `membershipId` and `membershipVersion`. There is no `CommunitiesService`.

11. **Not built in v1.** No halaqa link, no enrollment-sourced membership, and
    no capabilities derived from teaching assignments ([Q50]). If Q50 is
    answered yes, each is additive: a nullable, immutable `halaqa_id` checked
    through `ACADEMIC_RELATIONSHIPS`, a SYNC membership source, and a
    capability-source seam inside Communities. No contract changes.

12. **The governance gate applies (PROVISIONAL, [Q40]).** Implementing this
    module (P2 onwards) waits until the §13 step is complete or the user rules
    explicitly. Phase 0 corrections and the hardening of the existing live
    module (P1) change only existing modules and go ahead. Meanwhile, the name
    (decision 1) and the absence of a halaqa link (decision 11) keep this design
    from answering Q36. ADR 0015 stays reserved for the academic structure
    change (`academic-reconciliation.md:410`, `:490`, `:506`), which is why
    this package's ADRs are numbered 0016–0021.

## Consequences

If accepted:

- Membership scales on its own axis. 30,000 members is a membership scale:
  indexed, paged and counted. It is not a live-room scale
  ([0019](0019-community-scoped-live-sessions.md)) and not a
  realtime-connection scale: one API instance holds 10,000 connections
  (`realtime-policy.ts:42`). `COMMUNITY_MEMBERSHIP` exposes no count and no
  "load all", so nothing can size a live room from membership.
- The community row is the hot row, because every join updates it. Join storms
  are measured in load profile 4 (P8). If needed, the counter can be striped
  inside the adapter without a contract change.
- Messaging and Live can depend on Communities without a cycle. In return,
  Communities cannot report "live now" or a chat's last message: the client
  composes them from Live's and messaging's own routes.
- A leaked link is bounded by its expiry, `maxUses`, revocation, the lock and
  its creator's current authority. It never admits someone who lacks an
  account or `communities.read`.
- Adding ARCHIVED later takes a vocabulary value, a CHECK migration and one row
  of the effects table. No consumer changes.
- Identity changes only in its catalogue: four permissions and migration 0009
  ([0017](0017-community-scoped-authorization.md)).
- Mock mode keeps working: an in-memory adapter is chosen when no database is
  configured, as academic does.
- Nothing is implemented until the user rules on Q40.

## Alternatives considered

- **Keep membership in messaging**: a community as a `GROUP` or `CHANNEL`
  conversation, with invitations and a lock added to it. Rejected: the brief
  forbids messaging owning group membership rules; its caps are 500 and 10,000
  (`messaging-policy.ts:20-27`); its participant row mixes belonging with read
  state and history windows; lock and invitation concepts would enter
  messaging's domain.
- **Name the module and aggregate `groups`**, the brief's word and the name
  most of the decision records this package reconciles used. Rejected for
  decision 1: it collides with messaging's `GROUP` and would pre-answer Q36.
- **A `kind` field** (group, channel, announcement). Rejected: no Communities
  behaviour depends on it, who may post is decided per act
  ([0017](0017-community-scoped-authorization.md)), and it would pre-answer
  Q36.
- **One membership row per (community, user), upserted on rejoin** (messaging's
  model). Rejected: it overwrites who added or removed whom, cannot say
  reliably that someone last left as REMOVED, and gives capability grants no
  stable stint to attach to, so a rejoin could revive old grants.
- **An `owner_user_id` column on the community row.** Rejected: re-verifying
  the owner under lock would share-lock the row every join and every
  lock/unlock updates, the hottest row in a 30,000-member community. Ownership
  is standing on the stint, with a one-owner index and an owner-is-active
  CHECK.
- **`count(*)` for member counts.** Rejected: O(members) per community per
  request, multiplied across every community on a list page. The counter is
  O(1), and the Postgres suite proves it equals `count(ACTIVE)` under
  concurrency.
- **A stored invitation status column.** Rejected: expiry would need a sweeper,
  and the column would drift from `uses` and `max_uses`. Derived state is
  always exact.
- **A slow KDF, a salt or a pepper for tokens.** Rejected: lookup needs a
  deterministic hash, and a 256-bit random secret cannot be brute-forced.
- **The token in the URL, redemption by GET, or `POST /groups/:id/join`.**
  Rejected: paths are logged unredacted, link previewers prefetch GETs and
  would consume uses, and a community id in the path adds a mismatch case and
  an enumeration surface. The token already names the community.
- **Gate with `SELECT … FOR SHARE`, then update the counters.** Rejected: two
  transactions upgrading shared locks deadlock. The conditional UPDATE is both
  the gate and the increment.
- **Three lock orders**, one per decision record. Rejected for the single order
  in decision 9: versions stay unique and in commit order because they are
  allocated under the community row lock, held until commit.
- **A link stays valid after its creator loses the right to invite.** Rejected:
  the brief says an invitation must never bypass authorization, so redemption
  fails closed (PROVISIONAL, [Q48]).
- **A separate `communities.membership.changed` hint per transaction.**
  Dropped: one fact would have two events. `member.added` and `member.removed`
  carry `membershipVersion`, and consumers pull the feed.
- **Let each consumer interpret the status**, including a live-side lifecycle
  table. Rejected: lock policy would be spread over three modules, and a future
  ARCHIVED would fall through them silently. Communities alone owns decision 8.
- **Add ARCHIVED now.** Deferred: its meaning is policy ([Q47]), as Q32 decided
  for the academic structure. LOCKED already closes entry, posting and new live
  sessions.
- **Revoke every link automatically on lock.** Rejected: irreversible, and it
  destroys state the institution may want back after unlock.
- **Optimistic concurrency (`expectedVersion`) on lock and unlock.** Rejected:
  they set an absolute state, so there is no lost update to prevent.
- **A per-IP rate limit as the main brute-force control.** Rejected: a school
  behind one NAT would be throttled, and brute force is already infeasible.
  The per-user limit is primary; the per-IP limit only protects the database.
- **Link to halaqat and source membership from enrollment now.** Rejected: Q36
  is open, the reconciliation hold stands, `ACADEMIC_RELATIONSHIPS` ignores
  halaqa status, and academic events are not durable, so a synced copy would
  drift ([Q50]).
- **A `CommunitiesService` (or `GroupService`).** Rejected: a god service. One
  use case per act, a small gate, a journal and pure domain functions instead.
- **`activeLiveSessionId` on `GET /communities/:id`.** Rejected: it needs
  Communities → Live, which with Live → Communities closes a cycle. The client
  asks `GET /live/communities/:id/sessions/current`.
- **Treat the §13 gate as not covering this module.** Rejected: a design that
  rules itself outside a user's constraint lifts that constraint on its own
  (decision 12, [Q40]).
- **Number the new ADRs from 0015.** Rejected: 0015 is reserved by a document
  that is waiting on the owner; renumbering would edit it.

[Q2]: ../open-questions.md#q2--who-is-the-first-owner-and-how-are-accounts-created-after-that
[Q20]: ../open-questions.md#q20--messaging-limits
[Q36]: ../open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups
[Q40]: ../open-questions.md#q40--governance-which-gates-apply-to-the-new-modules
[Q46]: ../open-questions.md#q46--what-does-locked-mean-and-who-may-lock
[Q47]: ../open-questions.md#q47--retiring-a-community
[Q48]: ../open-questions.md#q48--invitation-links
[Q49]: ../open-questions.md#q49--leaving-removal-and-rejoining
[Q50]: ../open-questions.md#q50--communities-and-the-academic-structure
