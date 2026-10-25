# 0049 — The live room's four reactions: ephemeral, over the app's WebSocket, naming nobody

**Status:** Accepted — 2026-10-25 (owner request C15, issue 3). A new capability of the Live module. It
does **not** touch messaging: message reactions stay **excluded** (owner rejection, ADR 0043) — these are
gestures in a running broadcast, not reactions to a message. It does **not** enable LiveKit's data channel.

## Context

Since the live redesign the room showed a reactions strip — ❤️ 👍 👏 😊 (`favorite`, `thumb_up`,
`sign_language`, `emoji_emotions`) — and a «تفاعل» dock button, both as locked «غير متاح الآن»
placeholders: no route, no event, no frame existed. Those four, and only those, are what the owner asked to
work; nothing else is invented.

## Decision

- **The four kinds:** `heart`, `thumbs_up`, `clap`, `smile` (`live/domain/live-reaction.ts`). Any other
  value is `422 live.reaction_invalid`.
- **Send:** `POST /live/sessions/:sessionId/reactions` `{kind}` → `202 {reactionId, kind}`. Gates, in order:
  identity `live.join` (route and use case); a malformed id → 404; 30 a minute per (session, user) →
  `429 live.too_many_reactions`; the kind; the session (404); the caller takes part (`LiveAccess.participant`
  — `community.live.join`, or a moderator; anyone else gets the unknown session's 404, 412 for the
  lifecycle); the session is live (`412 live.session_not_live`).
- **Ephemeral:** nothing is stored, counted or audited (a person's own gesture, like a raised hand); no
  migration. The use case publishes `live.reaction.sent {sessionId, communityId, reactionId, kind, sentBy}`
  through the journal.
- **Deliver:** the realtime relay sends `live.reaction {communityId, sessionId, kind}`
  (`eventId = live.reaction:<sessionId>:<reactionId>`) to the session's participants connected here
  (`LIVE_AUDIENCE.participantsAmong`, asked at delivery), **except the sender's own devices** — they drew
  it as it was tapped. `sentBy` never leaves the server: a reaction names nobody, so it cannot reveal who is
  in the room (consistent with Q68's moderators-only roster). Another session's audience, a removed member,
  and the community's other members receive nothing.
- **The app:** `LiveRoomRepository.react` → `liveReactionsProvider(sessionId)` — the viewer's tap is drawn
  at once and sent, with a 300 ms cooldown so a held finger cannot flood; frames for this session only,
  deduplicated by event id; each burst floats up the stage's end edge for 2.4 s (fades in place under
  reduced motion) and is gone; nothing is replayed on reconnect and nothing outlives the session. The strip
  and the dock's quick heart are enabled for a viewer the server lets take part (`me.canJoin` or
  `me.canModerate`); others see them inert but still see the room's reactions. Icons, not emoji glyphs, so
  every platform draws them without fetching a font.

## Security and architecture trade-offs

- The transport is the app's own WebSocket (as the session chat, ADR 0047); LiveKit's data channel stays
  off for everyone (`canPublishData` false), so a listener still cannot broadcast on the media plane.
- No identity on the wire, no stored history: abuse is bounded by the per-user limit and by participation,
  re-asked on every send. A moderator cannot turn reactions off — no such control was asked for.
- Fan-out walks the community's online members per reaction (as start/end and chat frames do); acceptable
  at classroom sizes, the same bound as ADR 0047.

## Consequences

Tests: `live-reaction.spec.ts` (each kind, no audit, ids, validation, non-member, other session, removed
member, ended, lifecycle, ceiling, rate limit), `live-reaction-relay.spec.ts` (other participants only, the
sender's devices excluded, no identity in the frame, isolation, one frame per reaction, malformed facts
dropped), `test/api/live-room.api.spec.ts` (HTTP 202/400/401/404/412/422 and the WebSocket frame), Flutter
`live_reactions_test.dart`; architecture guards (route map, body-reading routes, limits catalogue).
