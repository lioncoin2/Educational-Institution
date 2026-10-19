# 0039 — Groups vs channels: a community chat mode, posting by capability

**Status:** Proposed — 2026-10-19 (Groups & Channels, owner-approved product behaviour). **Amends
[ADR 0016](0016-communities-module.md) in part** (reverses its decision 1, "A community has no
`kind`", and its rejected `kind` alternative) and **extends [ADR 0017](0017-community-scoped-authorization.md)**
(adds a membership basis for posting in an open group). Leaves [ADR 0018](0018-community-chat-projection.md)
intact (the community chat stays a CHANNEL conversation). Resolves **Q41**'s "kinds, if the
institution defines them, are a vocabulary column and a CHECK" and the **posting half of Q51**.

**Acceptance is the owner's.** The owner approved the product behaviour (groups open by default,
admins restrict/restore; channels publish-only). The schema and authorization design below are the
author's and are recorded here; the code is implemented in the working tree but **uncommitted and
unmerged** while this record is Proposed.

## Context

The brief's "groups" are the **Community** aggregate. ADR 0016 deliberately gave it no `kind`,
because no behaviour depended on one and a kind would pre-answer Q36 (Tahajji "groups" = academic
halaqat, since answered by ADR 0015). A community's single chat is an ordinary **CHANNEL**
conversation linked by `community_id` (ADR 0018); posting is decided not by the conversation type
but by the `community.chat.post` capability, asked on every send (community-chat.md §5). That
capability is **owner-implicit and grantable, never membership-derived** — so every community today
behaves like a channel: only the owner and delegated posters write.

The owner has now defined two products:

- **Group** — every active member posts by default; an admin can restrict ordinary members to
  read-only and restore them; a restricted group is still a group.
- **Channel** — only the owner and authorized publishers/admins publish; members read.

ADR 0016's premise ("no Communities behaviour depends on a kind") no longer holds: behaviour now
differs by product. A `kind`/mode is therefore warranted, exactly as Q41 anticipated.

## Decision

1. **A community carries a `chatMode`: `GROUP_OPEN | GROUP_RESTRICTED | CHANNEL`** — one additive,
   non-null column `communities.chat_mode` with a CHECK (migration `0025`). It encodes both the
   product kind (GROUP for the first two, CHANNEL) and, for a group, whether ordinary members may
   post. The product kind is immutable; only `GROUP_OPEN ↔ GROUP_RESTRICTED` may change
   (domain `setChatMode`). A new group is `GROUP_OPEN`, a new channel is `CHANNEL`; a community
   created without a kind defaults to GROUP.

2. **The community chat stays a CHANNEL conversation (ADR 0018 unchanged).** `chat_mode` is a
   community concept; the conversation type remains a display detail that never decides posting. No
   `conversations` migration; messaging's history, caps and type rules are untouched.

3. **Posting is still one act, `community.chat.post`, decided by the one evaluator** — but its rule
   now depends on the mode (ADR 0017 extended):
   - `CHANNEL`, `GROUP_RESTRICTED` → the **publisher** rule: owner-implicit or an ACTIVE grant,
     ceiling `communities.moderate + messaging.send` (unchanged from today).
   - `GROUP_OPEN` → a **member** rule (`POSTING_MEMBER_RULE`): any active member posts, on the
     membership basis, ceiling `communities.read + messaging.send` — never `communities.moderate`,
     never an individual grant.
   The lifecycle gate `chatPostingOpen` applies in every mode, so a **LOCKED** community still
   blocks everyone (groups and channels alike). The service (`CommunityAuthorizationService`) chooses
   the rule from the mode in the read, for `authorize`, `authorizeEach` and `permittedAmong` alike,
   so the hint the client sees and the enforcement on send never diverge.

4. **Restrict/restore is a new delegable capability, `community.chat.manage`** (ceiling
   `communities.moderate`, owner-implicit, oversight `communities.manage`, gate `always`) — distinct
   from `community.chat.post` (who publishes) and `community.messages.moderate` (who deletes), so the
   three concepts never conflate. It flips `GROUP_OPEN ↔ GROUP_RESTRICTED` only.

5. **The server is authoritative.** Every send re-asks `community.chat.post`; the conversation's
   `canPost`, the client's cached capabilities and the conversation type are never trusted. The `me`
   block gains a derived `canPost` (the authoritative signal the composer keys on). A realtime
   `community.chat_mode.changed` event is relayed to online members as the existing
   `community.access.changed` hint, so composers re-read `me`; a disconnected or reconnecting client
   re-reads over HTTP; a stale client that still shows a composer is refused on send.

## Consequences

- One aggregate, one evaluator, one posting act: no second entity, no parallel role system, no
  messaging change. Groups and channels are a community-level `chat_mode` + a capability.
- Open-group members post without a per-member grant (the gap ADR 0016's model had); channels keep
  exactly today's behaviour.
- **Compatibility:** `chat_mode` defaults to `GROUP_RESTRICTED`, so every pre-0039 community keeps
  its current behaviour (owner + delegated posters write; members read) and all history. No
  backfill query beyond the column default; no community is converted; nothing is deleted. Old API
  clients that create without a `kind` get a GROUP; clients that ignore the new `chatMode`/`canPost`
  fields keep working (server still enforces).
- Live sessions are community-scoped and unchanged by the mode.
- `community.chat.manage` extends the pinned act vocabulary (act-rules, lifecycle, the contract
  suite) and the grant CHECK (migration 0025), updated in lockstep.

## Alternatives considered

- **Conversation GROUP/CHANNEL type as the authority (Phase-5 option B).** Rejected: contradicts
  community-chat.md §5.1 ("the type is a display label only; branches key on `community_id`") and
  would move a security decision onto a display field — a bypass risk.
- **A `kind` field with no posting behaviour (naive option A).** Rejected: a kind that does not drive
  posting is dead data; the behaviour must live in the evaluator, which this decision does.
- **Reuse `community.messages.moderate` for restrict/restore.** Rejected: conflates posting-policy
  management with message moderation; the owner required the concepts kept distinct.
- **Make open-group posting a plain participation act.** Rejected: participation is satisfied by
  membership in *every* community, which would open channels and restricted groups too; the mode
  must gate it, which it does by rule selection.
- **Convert existing communities to a chosen kind.** Rejected for this feature: the owner said new
  groups use the new system and existing ones need no conversion; the safe default preserves their
  behaviour and leaves conversion to a later, explicit decision.
