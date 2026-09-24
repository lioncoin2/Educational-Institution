# 0022 — Community chat: every recipient page is checked against Communities, and a divergence rebuilds the projection

**State: PROPOSED (2026-09-24). Implemented in the P4 review fixes, and awaiting the user's acceptance.**

**Status:** Proposed
**Date:** 2026-09-24

**Why implemented before acceptance.** The P4 brief's §19 requires that
"Authorization must never become permissive because the projection is
stale. If uncertain, deny rather than bypass Community authorization."
Review found a case where [0018](0018-community-chat-projection.md)'s
decision 9 does exactly that (below). If the user rejects this record, the
change back is small. Decision 1 lives in `message-recipients.service.ts`.
Decisions 2 and 3 live in `conversation-access.ts` and in the sync, the
sweeper and the reconciler. Each has its own tests.

**Supersedes [0018](0018-community-chat-projection.md) in part.** Three parts
change:

- decision 9's lag filter, which checked a page against Communities only while
  the projected version differed from the head;
- the alternative 0018 rejected, "filter every recipient page through
  Communities", which this record adopts;
- decision 7's list of what starts the reconciler.

Everything else in 0018 stands, including the read ceiling on every page
(decision 9's second half). Builds on
[0021](0021-cross-cutting-rules-for-new-modules.md): its trigger T1 is a
projection used for authorization with no reconciler. The implementation is
recorded in [community-chat.md §20.2](../community-chat.md#202-choices-made-during-implementation).

## Context

0018 let a recipient page through without asking Communities whenever the
projection's version equalled the community's head. Its reason, among the
alternatives, was that "the version comparison gives the same membership
safety". That holds while versions are never reused. It fails after
Communities is restored from a backup:

1. Communities is restored to head H. The projection has already applied
   changes up to P > H, and those changes are lost from the authority.
2. Communities hands versions H+1 … P out again, to different changes. Their
   wake-ups reach the sync within milliseconds, before any sweep can see
   P > H. The sync pulls from P, finds nothing, and the projection's version
   equals the head.
3. From then on nothing looks behind or ahead. A lost join stays a
   recipient: that person gets frames and notification rows for a chat they
   do not belong to. A lost removal keeps a real member out, because repair on
   access writes the member's stint at a version ≤ H, which loses to the lost
   tombstone above H. The real changes at H+1 … P are never applied.

Two variants fail the same way:

- a row written by repair on access above the projected version (the
  projected version never moved, so no sweep sees it ahead);
- a lost rejoin whose row is ahead of the stint Communities vouches for.

All three are now tests, under "after Communities was restored behind the
projection" in `community-chat.spec.ts`.

## Decision

1. **Every recipient page is checked.** For a community chat, each non-empty
   page from the projection is narrowed to the people
   `COMMUNITY_MEMBERSHIP.statesOf` reports ACTIVE, whether the projection lags
   or not. One call per page. The read ceiling then narrows the page further,
   as 0018 decision 9 already required.
2. **A divergence asks for a rebuild.** The projection holding a change that
   Communities never made is the signature of a restore. Three places can see
   it, and each calls `CommunityChatSync.requestReconcile`:
   - **a recipient page** that holds someone Communities has no stint for, or
     reports gone by a change at or below `min(projected, head)`, which the
     projection claims to reflect;
   - **an access refusal or an ignored repair** on a row whose change
     Communities' latest state for that person does not account for: no
     stint, a lower version, or a different stint or state at the same
     version;
   - **an admission** where the row is ahead of the permit's stint and
     Communities never made that change.

   An ordinary lag, meaning a change Communities made that the projection has
   not applied, schedules a sync, as before. No signal changes the answer
   being given.
3. **Rebuilds run in the sync's per-community worker.** The reconciler runs
   there before the worker's next pull, so no pass over that community runs
   alongside its rebuild. The sweeper hands an ahead projection to the sync.
   A pass rebuilds at most once. If the projection is still ahead afterwards,
   the sync logs an error and stops; it never loops.

## Consequences

- Nobody Communities does not hold as ACTIVE receives a frame or a
  notification row, whatever state the projection is in.
- A member who joined but is not projected yet is still missed until the sync
  or a rebuild applies them. That fails closed, as before: they read the
  message over HTTP.
- A member kept out by a lost tombstone gets 404 until the rebuild their own
  request asked for has run, seconds later. Before, they stayed out until an
  operator noticed.
- **The cost is one `statesOf` per recipient page, steady state included**:
  the "doubled fan-out reads" 0018 rejected. The measurements, from the
  development container
  ([community-chat.md §20.6](../community-chat.md#206-evidence-at-30000-members-p4-brief-16)):
  - At 30,000 members a page of 1,000 takes 41–43 ms at p99, against 18 ms
    with the lag filter.
  - The 30-page walk takes 1.1–1.2 s, against 0.36 s.
  - Below the capacity switch (250 members, one page) the cost is one extra
    statement per message.
- Communities' `latestStints`, which answers `statesOf`, now binds its ids as
  one array parameter. This removes a query-building cost (about 30 ms per
  1,000 ids) and leaves the plan unchanged.

## Alternatives considered

- **Keep decision 9 and rely on the sweeper.** Rejected: the sweeper can only
  see P > H, and reused versions erase that within milliseconds.
- **A restore detector in Communities' head.** A digest chained over the
  membership changes, stored with the projection and compared with the
  head's, would make the per-page check unnecessary whenever the two match.
  **Deferred**, not rejected: it adds state to Communities, which is
  Communities' to decide
  ([community-chat.md §20.8](../community-chat.md#208-deferred)).
- **An epoch id in Communities, changed on restore.** Rejected: a restore
  brings the old epoch back along with the data. The id would have to live
  outside the database.
- **Rebuild every chat on every sweep.** Rejected: the cost grows with the
  size of every community, every 60 s.
