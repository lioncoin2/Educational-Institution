# 0022 — Community chat: every recipient page is checked against Communities, and a divergence rebuilds the projection

**State: ACCEPTED (2026-09-24). Implemented in P4's review fixes.**

**Status:** Accepted
**Accepted:** 2026-09-24, by the user, who kept the implementation.
**Date:** 2026-09-24

**Supersedes and replaces the delivery shortcut of
[0018](0018-community-chat-projection.md).** Under 0018, a community chat's
recipient page went out without asking Communities whenever the
projection's membership version equalled the community's head. That shortcut
is gone:

- **0018 decision 9's lag filter is replaced.** Every recipient page is now
  checked against Communities, whether the projection lags or not (decision 1
  below).
- **0018's rejected alternative is adopted.** 0018 rejected "filter every
  recipient page through Communities". This record adopts it, for a reason
  0018 did not have (see Context).
- **0018 decision 7 is extended.** More events now start the reconciler
  (decisions 2 and 3 below).

Everything else in 0018 stands, including the read ceiling on every page (the
second half of its decision 9). 0018 is kept as the historical record: its
text is not rewritten, and it points here. This record builds on
[0021](0021-cross-cutting-rules-for-new-modules.md), whose trigger T1 is "a
projection used for authorization with no reconciler". The implementation is
recorded in [community-chat.md §20.2](../community-chat.md#202-choices-made-during-implementation).

**Implemented before it was accepted.** Review of P4 found the failure
described below. The P4 brief's §19 says that "Authorization must never
become permissive because the projection is stale. If uncertain, deny rather
than bypass Community authorization." So the fix landed with P4's review
fixes while this record was still Proposed. The user accepted it on
2026-09-24 and kept the implementation.

## Context

### Why equal membership versions are not enough after an independent restore

Communities numbers each membership change of a community (a join, a leave, a
removal) with the next `membershipVersion`. That counter lives in
Communities' own tables. Messaging's projection lives in messaging's tables
and remembers the highest version it has applied, in
`projected_membership_version`. Neither module reads the other's tables.

0018 treated "projected version = head" as proof that the projection
reflects the authority. That proof holds only while a version number always
names the same change.

An **independent restore** breaks it. Communities' data goes back to an
earlier point, but messaging's does not. That happens when Communities'
tables are restored on their own, or, once modules keep separate databases,
when Communities' database is restored on its own. The counter goes back and
the projection does not, so Communities issues the lost numbers again, to
different changes:

1. Communities is restored to head H. The projection has already applied
   changes up to P > H, and those changes are lost from the authority.
2. Communities hands out versions H+1 … P again. Their wake-ups reach the
   sync within milliseconds, before any sweep can see that P > H. The sync
   pulls from P, finds nothing, and the projection's version now equals the
   head.
3. From then on nothing looks behind or ahead, yet equal numbers name
   different histories:
   - A lost join stays a recipient.
   - A lost removal keeps a real member out. Repair on access writes the
     member's stint at a version ≤ H, which loses to the lost tombstone above
     H.
   - The real changes at H+1 … P are never applied.

Two variants fail the same way:

- a row that repair on access wrote above the projected version (the
  projected version never moved, so no sweep sees the projection ahead);
- a lost rejoin whose row is ahead of the stint Communities vouches for.

All three are tests, under "after Communities was restored behind the
projection" in `community-chat.spec.ts`.

### Why delivery must fail safe against Communities

HTTP never trusts the projection: every read and every send asks Communities
for a permit first (0018 decision 8). Delivery works differently.
`MESSAGE_RECIPIENTS` answers in-process fan-out that runs on behalf of no
principal:

- realtime pushes a `message.sent` frame, which carries the message itself;
- notifications stores a row for each recipient.

Nobody asks Communities after that. The recipient page is the only
authorization those frames and rows ever get.

A page taken from a stale projection therefore hands a message to someone
who may not read it: authorization made permissive by a stale projection,
which the P4 brief's §19 forbids. The two ways a page can be wrong are not
equal:

- **Including a non-member discloses content**, and a delivered frame or row
  cannot be taken back.
- **Missing a member only delays**: they read the message over HTTP, where
  the permit decides.

Delivery must therefore err on the second side. Every page is narrowed by
Communities' own answer and never widened.

## Decision

1. **Every recipient page is checked.** For a community chat,
   `MessageRecipientsService` reads, in order:
   1. the community's head (an unknown or unreadable community gives an
      empty page, as before);
   2. a page of up to 1,000 current rows from the projection;
   3. one `COMMUNITY_MEMBERSHIP.statesOf(communityId, userIds)` call for
      exactly the people on that page.

   It keeps only those Communities reports ACTIVE, whether the projection
   lags or not, and then applies the read ceiling (0018 decision 9,
   unchanged). There is one call per non-empty page and none for an empty
   one. The cursor still continues after the last row examined, so a page
   may be shorter than its limit, and nobody is skipped or repeated.
2. **A divergence asks for a rebuild.** The projection holding a change that
   Communities never made is the signature of a restore. Three places can
   see it, and each calls `CommunityChatSync.requestReconcile`:
   - **a recipient page** that holds someone Communities has no stint for, or
     reports gone by a change at or below `min(projected, head)`, which the
     projection claims to reflect;
   - **an access refusal or an ignored repair** on a row whose change
     Communities' latest state for that person does not account for: no
     stint, a lower version, or a different stint or state at the same
     version;
   - **an admission** where the row is ahead of the permit's stint and
     Communities never made that change.

   An ordinary lag (a change Communities made that the projection has not
   applied yet) schedules a sync, as before. No signal changes the answer
   being given.
3. **Rebuilds run in the sync's per-community worker**, before its next
   pull, so no pass over that community runs alongside its rebuild. The
   sweeper hands an ahead projection to the sync. A pass rebuilds at most
   once. If the projection is still ahead afterwards, the sync logs an error
   and stops; it never loops. A failed rebuild stays requested.

## Consequences

- Nobody Communities does not hold as ACTIVE receives a frame or a
  notification row, whatever state the projection is in.
- A member who joined but is not projected yet is still missed until the
  sync or a rebuild applies them. That fails closed, as before.
- A member kept out by a lost tombstone gets 404 only until the rebuild
  their own request asked for has run, seconds later. Meanwhile they take no
  conversation lock. Before, they stayed out until an operator noticed.

### The performance trade-off

The check costs one `statesOf` per recipient page, in steady state too. This
is the doubling of fan-out reads that 0018 rejected. The cost is bounded by
the page, never by the community: at most 1,000 ids per call.

These figures were measured on the development container, not on production
hardware ([community-chat.md §20.6](../community-chat.md#206-evidence-at-30000-members-p4-brief-16)):

| At 30,000 members | Before (lag filter) | After (every page checked) |
| --- | --- | --- |
| One recipient page of 1,000 ids, p99 | 18 ms | 41–43 ms |
| The whole 30-page walk | 0.36 s | 1.1–1.2 s |

Below the capacity switch (250 members, so one page) the check is one extra
statement per message.

Communities' `latestStints`, which answers `statesOf`, now binds its ids as
one array parameter. Binding 1,000 separate parameters took about 30 ms more
than running the query. The plan is unchanged: at production volume it is
index probes, pinned by `communities-scale.spec.ts` at ~900,000 stints.

This is the price of not trusting a projection that cannot prove it agrees
with the authority. The next section describes how to stop paying it without
starting to trust it.

## Future optimization: a membership digest

The per-page check exists because an equal version number does not prove an
equal history. A digest would prove it.

- **In Communities.** This is Communities' decision, and it is not made
  here. Communities would keep a digest chained over a community's
  membership changes: the digest at version v is a hash of the digest at
  v−1 and change v. It would be updated in the same transaction as
  `membershipVersion` and returned with the head (`CommunityHead`). A
  restore rewinds the digest along with the counter, so a reissued version
  yields a different digest.
- **In messaging.** Messaging would store the digest at
  `projected_membership_version` next to that version, written by the
  applier each time a page advances it (one additive column).
- **The seam.** The community page in `MessageRecipientsService` is the only
  place the per-page check is made.
  - When the head's version and digest both equal the projection's, that
    page could skip `statesOf`.
  - A digest that differs at an equal version is the restore signature, and
    would ask for a rebuild at once.
  - A projection whose version differs from the head's would still be
    checked page by page, as now.
  - The read ceiling stays on every page regardless, because it is
    identity's answer, not membership's.

The digest is deferred, not rejected. It adds state and a contract field to
Communities, which is Communities' to decide, and the per-page check is
correct without it.

## Alternatives considered

- **Keep 0018's lag filter and rely on the sweeper.** Rejected: the sweeper
  can only see P > H, and reissued versions erase that within milliseconds.
- **Detect by row: a chat row whose `source_version` is above the head.**
  Rejected: once Communities has reissued the lost versions, no row is above
  the head.
- **An epoch id in Communities, changed on restore.** Rejected: a restore
  brings the old epoch back along with the data. The id would have to live
  outside the database.
- **Rebuild every chat on every sweep.** Rejected: the cost grows with the
  size of every community, every 60 s.
- **A membership digest now.** Deferred; see the section above.
