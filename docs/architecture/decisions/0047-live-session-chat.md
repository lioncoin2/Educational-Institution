# 0047 — A live session's own chat: Live's table, a server-side lock, delivered to participants only

**Status:** Accepted — 2026-10-25 (owner decision F, register §30). New capability of the Live module; it
does not change community chat (ADR 0018/0029/0039) and does **not** enable LiveKit's data channel.

## Decision

- **Separate data.** A session's chat is Live's own table `live_chat_messages` (session id → `live_sessions`,
  RESTRICT; sender, client key, text ≤ 500 characters, server time, a `position` sequence). It is never a
  community-chat message and nothing of it reaches the community's conversation history. Kept with its
  session — nothing deletes a row (Q3); a retention policy would be a separate decision.
- **Who reads.** Everyone who may see the session (`LiveAccess.viewer`): participants, moderators, and a
  member the lifecycle keeps from joining. An ended session's chat stays readable. Anyone else: the 404 an
  unknown session is.
- **Who posts.** Every participant by default (`community.live.join` or a session moderator, identity
  `live.join`), only while the session is live, rate-limited per (session, user) 20/min, idempotent per
  client key.
- **The lock.** A session moderator (`community.live.moderate`, or the host while `community.live.host`
  holds — `LiveAccess.moderator`) closes the chat to participants and re-opens it
  (`PUT`/`DELETE /live/sessions/:id/chat/lock`, audited `live.chat.locked`/`live.chat.unlocked`). While
  locked only moderators post; a participant's post is `403 live.chat_locked`. The lock is two columns on
  the session row (`chat_locked`, `chat_lock_version`), decided **at the write**: a post reads the session
  row `FOR SHARE` in its own transaction, a lock change updates it under the session's lock, so a post that
  reaches the store after a lock committed is refused whatever the client showed. Every new session starts
  open. A moderator who loses moderation is refused on their next locked post.
- **Realtime.** Events stay ids-only (`live.chat.posted`, `live.chat.lock_changed`); the realtime relay
  renders a post through a new principal-less `LIVE_CHAT` reader and sends `live.chat.message` (the message,
  with the sender's name) and `live.chat.changed` (`locked`, `lockVersion`) to the session's participants
  connected here (`LIVE_AUDIENCE.participantsAmong`), never the community's other members, never another
  session's audience. Unlike every other live frame, `live.chat.message` carries text and a name: it *is*
  the message, for the people in the session.
- **Lifecycle.** Late join / reconnect: the client reads `GET /live/sessions/:id/chat` (newest page, the lock,
  `canPost`, `canModerate`) and merges frames by id; a newer `lockVersion` re-reads. On end, posting and
  locking answer `412 live.session_not_live`. Removal from the community ends read and post at once.
- **Not a shortcut.** LiveKit's data channel stays disabled; the chat works with the fake provider too.

Migration `0033_live_session_chat` (generated, additive): the table, its unique client-key index and page
index, the body-length CHECK, and the two defaulted session columns — existing sessions are open, version 0.

## Security trade-offs

- Text and names in a frame: limited to the session's participants, asked at delivery time; nothing in an
  event, a log or the audit trail carries text.
- One hot row: posts take a shared lock on the session row (they never wait on each other); a lock change
  briefly waits for posts in flight. Acceptable for classroom sizes; a very large session would need the
  lock moved off the session row.
- Delivery fan-out walks the community's online members per post (as start/end frames do).
- No moderator deletion of a single chat message and no per-person mute were approved — the lock is the
  only moderation tool.

Tests: `live-chat.spec.ts` (default posting, retry, bounds, ids-only event, paging, lock/unlock/repeat,
delegated moderator vs member, fresh session open, non-member, cross-community isolation, end, removal, late
join), `live-chat-relay.spec.ts`, `live-chat.api.spec.ts` (HTTP + WebSocket), `live-chat-postgres.spec.ts`
(0033 on a 0032 database with rows, deterministic lock-vs-post interleaving, retry storm, concurrent posts),
architecture guards (route map, `LIVE_CHAT` importers), Flutter `live_chat_test.dart`.
