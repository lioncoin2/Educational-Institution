# 0048 — The live room shows participants' real pictures: identity's reference, Files' link, asked of the session

**Status:** Accepted — 2026-10-25 (owner request C15, issue 1). **Extends**
[ADR 0038](0038-identity-and-community-profile-media.md) (profile pictures: identity holds the reference, Files verifies and links)
to the live room. Changes no Live policy, no Q68 roster rule and no media capability; adds one read route
and a Live → Files contract edge.

## Context

The live room drew every participant — the teacher included — as a letter: `AppAvatar(name: …)` with no
picture, in the presence rows, the moderator roster and the viewer's own row (which even took its letter
from «أنت»), and the stage showed a glyph for the host. Nothing in Live could give a picture: the only
person-level link route, `GET /people/:id/avatar`, is OWNER/ADMIN (`people.read`), and messaging's sender
link is scoped to a message. The live client knows each participant only by account id (the media
identity) and the name the server put in their token or in the hands page.

## Decision

- **One source of truth, reused.** `GET /live/sessions/:sessionId/participants/:userId/avatar` (route gate
  `live.join`; the use case re-asks `files.read`) answers Files' own 5-minute link
  (`{url, expiresAt}`) — the same shape every avatar route answers — from identity's `avatarFileAssetId`,
  after Files confirms the asset is still an image that person owns. Live stores no picture, no link and no
  reference; there is no second avatar source.
- **Whose picture: exactly whose identity the room already shows the caller.** The caller must see the
  session (`LiveAccess.viewer`, else the 404 of an unknown session). Then: themself, the host and the
  session's current presenters — named to every viewer by the session view; or, for a session moderator,
  anyone who may take part now (`community.live.remain` or a moderator — the named roster and the hands
  queue are moderators' alone, [Q68](../open-questions.md#q68--what-counts-as-present-in-a-snapshot)). Anyone else, no picture, a stale or swapped
  reference, or a malformed id: `404 live.participant_avatar_not_found` — the room draws initials, and a
  listener learns nothing about who else is in the community. An ended session's people stay as visible as
  the session.
- **The app.** `LiveRoomRepository.participantAvatarUrl` (a new interface beside `LiveRepository`, so its
  many test doubles are untouched) → `liveParticipantAvatarProvider` (one read per session × person,
  shared by every place that shows them; null on any failure) → `LiveParticipantAvatar` →
  `AppAvatar`, still the one place a picture is drawn. The viewer's own picture comes from their account
  (`ownAvatarUrlProvider`), with their own initial. The stage's on-air emblem shows the host's picture at its
  centre, the broadcast glyph when there is none. Initials hold the place while a picture loads (no layout
  shift); a failed load stays initials.
- **Camera and screen.** The platform has no camera source (ADR 0019/0028): there is no video tile to keep
  or replace. A presenter's shared screen still takes the whole stage — the picture never covers a live feed.

## Consequences

- Live's module now imports `FilesModule` for `FILE_ASSETS` (as messaging, Communities, people and
  academic do; Files imports only identity — no cycle). The live-boundaries guard and the module spec name it.
- A link expires after five minutes; a picture already drawn stays drawn (the image cache holds it), and a
  row shown again after expiry fetches a fresh link. A participant who changes their picture mid-session is
  seen with the new one the next time their row is built.
- Tests: `participant-avatar.spec.ts` (each rule, stale/swapped references, non-member, malformed ids,
  `files.read`, ended session), `test/api/live-room.api.spec.ts` (over HTTP; the link serves the image),
  Flutter `live_participant_avatar_test.dart` (rows, roster, self, the teacher on stage, none, failure,
  loading without shift, shared screen keeps the stage, one read per person across re-reads/reconnects).

## Alternatives considered

- **`GET /people/:id/avatar`** — refused: OWNER/ADMIN only, by design (migration 0020).
- **Putting picture links in the join token or the hands page** — rejected: a link expires in minutes and a
  token is media credential; the hands page is moderators'.
- **A picture for every remote the SDK reports, to everyone** — rejected: it would undo Q68 for pictures.
