# 0053 — Chat message reactions

**Status:** Accepted
**Date:** 2026-11-06

## Context

Toward a Telegram-like chat, the owner asked for emoji reactions on messages
(the highest-impact of the requested features). Messaging already has a message
timeline, replies and a single pin, delivered over realtime; reactions are a new
per-message, per-member fact that must show on every delivery path and update
live.

## Decision

A **persisted, toggled, one-per-member** reaction from a **curated, closed set**
of six emoji (`domain/reaction.ts`). It rides the EXACT seam a send does — a
member who may post in a conversation may react in it — so it works uniformly in
direct, group and community chats, re-authorized per call like any send.

- **Storage:** a `message_reactions` table (migration 0036), primary key
  `(message_id, user_id)` so a second tap swaps or removes, cascading with the
  message. One route: `POST /conversations/:id/messages/:messageId/reactions`
  `{emoji}` (toggle), `204`.
- **Read path:** the reaction summary is attached in the one view renderer
  (`MessagingViews.messages`) via a batched `reactionsOf(messageIds, viewerId)`
  on the read model — never one query per message — so every path (timeline,
  send response, realtime) carries `reactions: [{emoji, count, mine}]`.
- **Realtime:** a new `messaging.message.reacted` event (id + authoritative
  counts, never who-reacted-with-what) relayed as a `message.reacted` frame to
  the conversation's connected members, mirroring the pin relay.
- **Privacy:** counts are public to whoever can read the chat; the per-member
  rows are not exposed and nothing is audited (a reaction is a light act).

## Alternatives rejected

- **Ephemeral reactions** (like live-broadcast reactions): Telegram reactions
  persist with counts, so chat reactions are stored, not fire-and-forget.
- **Arbitrary emoji:** a closed set keeps a reaction a known, renderable glyph
  and lets the column be length-checked; widening it is one line in
  `reaction.ts`.
- **Restructuring the core message query** to join reactions: rejected for a
  batched side-load in the renderer, leaving the timeline query untouched.

## Consequences

- One new table and event; no change to the message row, the send path or the
  pin/edit/delete flows. Verified: typecheck, lint, dependency rules, the
  messaging + realtime suites, a use-case spec over real authorization, and a
  Postgres integration spec (toggle, counts, cross-conversation 404, concurrent
  toggle). The Flutter client renders and toggles them in a following change.
