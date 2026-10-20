# 0041 — Mass publishing: one post to several communities, authorized per community

**Status:** Accepted — 2026-10-20 (owner decision, register §29: included in the first web-first Trial
release). Proposed 2026-10-19 (owner-directed). Adds a mass-publish path to the `messaging` module:
one notice / file / image / voice recording published to several communities at once, each community
authorized on its own. It introduces **no** new permission, **no** migration, and **no** notification
policy; it orchestrates the existing community-chat send. It is **distinct from «نظام الضخ»** (the
academic student-progression move, GROUP C / register §22, which stays EXCLUDED) — this is the
communication/broadcast feature of roadmap domain 3, whose "Next action" was an owner decision; this
record is that decision, implemented in the working tree (uncommitted, unmerged) while Proposed.

## Context

A community's chat is an ordinary CHANNEL conversation owned by `messaging`, posted to through the one
`MessageSender` path, which already (a) asks Communities for the per-community `community.chat.post`
permit on every send, (b) accepts image/voice/file attachments verified against the `files` module, and
(c) is idempotent by `clientMessageId` (ADR 0018, 0011). Nothing existed to post **one** message to
**many** communities in a single request with a per-community result and a safe retry. The owner directed
building exactly that for files/images/audio recordings, with per-community authorization and correct
handling of partial failure and retry.

Every message still needs a real member-sender allowed to post (ADR 0011 dec 6 / Q53): mass publishing is
**not** a system broadcast and invents no senderless message.

## Decision

1. **A per-community-authorized fan-out.** `POST /messaging/communities/publish` (edge
   `messaging.send`) takes `{ clientBatchId, communityIds[], kind, body?, fileAssetId? }` and, for each
   target, posts an **ordinary** community-chat message through the existing `MessageSender` path — so the
   `community.chat.post` permit, the capacity switch, the attachment checks and the existing
   delivery/notification behaviour all apply unchanged, per community. The use case authorizes the whole
   batch once with Communities' `authorizeEach(community.chat.post)` (so a chat is **not** materialized for
   a community the viewer may not post in), then posts only to the authorized ones.

2. **Partial failure is the normal case, never a thrown batch.** The response is an `ok` report carrying a
   per-community outcome — `posted` / `already_posted` / `forbidden` / `not_found` / `locked` /
   `over_capacity` / `rate_limited` / `unavailable` / `failed` — plus a `retryable` flag true only for the
   transient refusals (`unavailable`, `rate_limited`). A `not_found` community is the same answer a
   non-member always hears, so the feature is no enumeration surface.

3. **Idempotent retry.** The per-community `clientMessageId` is a bounded, deterministic digest of
   `clientBatchId` and the community id. Resending a batch with the same `clientBatchId` returns the
   original message for a community that already received it (`already_posted`) instead of a duplicate, so
   the client safely retries only the transiently-failed subset — or the whole batch.

4. **A bad attachment fails the whole request, before anything is posted.** A media publish verifies the
   `fileAssetId` once (the sender's own, ready, of an accepted kind) and refuses the request if not; this
   is a request-level error, not a per-community outcome. A file is uploaded once (`POST /files/uploads` →
   complete) and the one reference is published to every target — a Files asset is a free-standing
   resource with no single-use coupling.

5. **No new policy.** No new permission (edge `messaging.send`, per-community `community.chat.post`), no
   migration, and **no notification change**: each post behaves exactly like a human posting the same
   message in each community, so the Q28 large-channel / priority / always-deliver questions are neither
   touched nor presumed.

## Consequences

- An owner/staff publisher reaches, in one action, every community they may post in, with an honest
  per-community result and a safe retry — on real data, proven by an HTTP end-to-end spec (fan-out, a
  real image upload reused across communities, forbidden/not_found/locked outcomes, idempotent retry,
  ownership rejection).
- `messaging` gains one route and one use case; it reuses its existing edges to `communities/contracts`
  and `files/contracts` (no new module edge; dependency-cruiser clean). The authorization route-declaration
  guard lists the new route under `messaging.send`.
- The Owner Command Center surfaces this as a quick action (`publish.communities`, gated `messaging.send`)
  — the command centre's actions registry (ADR 0040 follow-on) lists only the actions the viewer may
  perform, each re-authorized on use.

## Alternatives considered

- **A dedicated "announcements" module / senderless broadcast** — rejected: ADR 0011 removed senderless
  messages (Q53), and large-channel notification behaviour is Q28-open. Mass publishing stays ordinary
  member posts, so it needs no new policy.
- **Scheduling / dynamic audiences** — out of scope: not owner-approved (scheduling build is NOT approved,
  register §24); this publishes now, to an explicit set of communities.
- **A new per-community-post permission** — unnecessary: `community.chat.post` already decides posting per
  community; mass publishing is N of the same authorized post.
