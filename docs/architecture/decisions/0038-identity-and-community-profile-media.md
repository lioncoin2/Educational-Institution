# 0038 — Profile pictures and community profile editing, on the Files module

**Status:** Proposed — 2026-10-19 (Identity & Community Profile Foundation, Phase 1). Extends the
Files contract's reach (ADR for `files` Messaging V1) to profile media, adds one delegable
community capability to the vocabulary of [ADR 0017](0017-community-authorization-model.md) /
[0034](0034-q50-enrollment-sourced-membership-and-derived-capabilities.md), and adds columns to
`identity.users` and `communities`. Supersedes nothing; every other ADR is unchanged.

**Acceptance is the owner's.** The feature was requested by the owner (user avatar, community
picture + name + description, and the message sender's picture). The engineering placement below is
the author's and is recorded here; the code that implements it is not merged while this record is
Proposed. One product question is deliberately left to the owner — see Consequences §5.

## Context

Phase 1 adds three pieces of display identity: a user's own profile picture, a community's picture
(alongside its name and a new description), and the picture of a message's sender. The repository
already has the one primitive this needs — the **Files** module: allow-listed, content-verified
uploads addressed by a stable asset **id**, served only through short-lived signed links, with the
module that attaches a file authorizing its own readers (`FILE_ASSETS`: `verifyAttachable`,
`createDownloadLink`, `describe`). Messaging already consumes it for attachments.

Two facts shape the design:

- **A URL is not a reference.** A link expires; the thing stored on a user or a community must be
  the asset **id**, turned into a link at read time. (The Files contract says this in its own words.)
- **The dependency runs `files → identity`.** Files authorizes uploads with identity's
  `AUTHORIZATION_SERVICE`. So identity *cannot* import Files — that is a Nest module cycle, which
  the architecture forbids (no `forwardRef`). Yet a user's picture must live with the rest of their
  displayable identity (the name messaging already resolves through identity's `ACCOUNT_DIRECTORY`),
  or every consumer that shows a name beside a picture would need a second resolver in another
  module. The picture reference therefore has to be stored in identity but verified by Files.

## Decision

1. **A picture is a Files `IMAGE` asset referenced by id — never a URL, never a second file store.**
   Uploading is the existing `POST /files/uploads` → `PUT` → `complete` flow unchanged. What is new
   is where the resulting id is bound and how it is served.

2. **The user's picture is stored in identity and set through Files.**
   - `identity.users.avatar_file_asset_id` (nullable) holds the reference; it surfaces as a
     *reference* on `GET /auth/me` and on identity's `AccountSummary` (so it travels with the name
     through `ACCOUNT_DIRECTORY` to messaging and people, with no new module edges).
   - Identity exposes a narrow write contract, `ACCOUNT_AVATAR_WRITER` (`setAvatar`/`clearAvatar`),
     and stays the only module that writes `users`.
   - Files hosts the self-service endpoints (`PUT`/`DELETE /files/me/avatar`): it verifies the asset
     is an `IMAGE` the caller owns (`verifyAttachable`) and only then calls the identity writer.
     Files already depends on identity, so this adds no cycle; identity never learns of Files.
   - A caller mints a link to their **own** picture through `POST /files/me/assets/:assetId/link`
     (Files authorizes the owner of an asset to link it — the one read path Files decides itself).

3. **The message sender's picture rides the view-time resolver that already carries the name.**
   `AccountSummary` gains `avatarFileAssetId`; messaging's `PersonView` carries it on the `senders`
   array of a message page (no column on any message, no protocol change). A member mints a sender's
   picture link through a message-scoped route
   (`GET /messaging/conversations/:id/messages/:messageId/sender/avatar`): the sender is the
   message's own `senderId`, so there is no untrusted id, and Files re-verifies the asset is an
   image that sender owns before minting — a reference the sender later cleared cannot leak.

4. **A community gains a `description`, a picture, and one new delegable capability,
   `community.profile.edit`.** `communities.description` and `communities.avatar_file_asset_id`
   (nullable) are added. `community.profile.edit` joins `COMMUNITY_CAPABILITIES` with the single
   delegable-capability ceiling `communities.moderate` (ADR 0017), owner-implicit, oversight-reachable
   by `communities.manage` (an overseer may correct a community's profile, as it may lock one), and
   lifecycle gate `always` (a correction stays possible while LOCKED — it is management). Editing is
   a full replace of title + description + picture through `PUT /communities/:id/profile`; a **new**
   picture is verified through `FILE_ASSETS` (communities → files, no cycle) before it is stored, and
   the unchanged picture is left untouched so an overseer need not own the image already there. A
   viewer who may see the community mints its picture link through `GET /communities/:id/avatar`.

## Consequences

1. No second file system, no storage port widened, no vendor change: three consumers (identity's own
   profile, messaging senders, communities) reuse the one `FILE_ASSETS` contract exactly as messaging
   reuses it for attachments.
2. Identity stays cohesive and cycle-free: it owns the reference and its storage; Files owns the
   "is this an image this account owns?" check. The split is explicit in `ACCOUNT_AVATAR_WRITER`.
3. The picture is always resolved beside the name, through one resolver — so a bubble, a profile
   header or a roster row needs no extra module to show a face.
4. Backward compatible: every reference is nullable; an account or community with no picture, an old
   message whose sender is gone, and an older client that ignores the new field all behave as before
   (the default initials view). The three migrations (`0023_user_avatar`, `0024_community_profile`)
   are additive; `0024` also widens the grant-capability CHECK to accept the new capability.
5. **Open for the owner (not a blocker):** a self-uploaded picture is shown to the same audience that
   already sees that account's **name** — in a conversation, to the conversation's members. For a
   single-institution Qur'an app with minors and female students, whether a student's or teacher's
   face should be visible to that same audience is a safeguarding decision that belongs with
   [GROUP A / Q22 / Q31](../../owner-decision-register.md) (who may see whom). The build is
   conservative: a picture is **opt-in** (no default image; initials otherwise), visible only where
   the name already is, and never minted for an account the viewer could not already see. Narrowing
   it later (e.g. no pictures for minors, or role-gated visibility) remains open.

## Alternatives considered

- **Make `FilesModule` global so identity could inject `FILE_ASSETS`.** Rejected: `@Global` is used
  only for platform infrastructure here, not business modules; it would hide the dependency and set a
  precedent. The write-contract split keeps the direction explicit.
- **Store the user's picture in the `people` module** (profiles). Rejected: the picture must travel
  with the name, which messaging resolves through identity's `ACCOUNT_DIRECTORY`; storing it in
  people would force a second resolver and a new `messaging → people` edge, and people is directory-
  policy-blocked (Q22/Q31).
- **Store an unverified reference and verify only at link time.** Rejected for set-time verification:
  the owner's flow is upload → **verify** → store, and storing an unverified reference is poorer
  feedback. Link-time re-verification is still done for sender pictures as defence in depth.
- **A separate community avatar capability vs. reusing `community.lock`.** Rejected reuse: it would
  conflate lifecycle with profile and break `community.lock`'s pinned meaning. A new, delegable
  capability is the vocabulary's own pattern.
- **Emit a realtime `community.profile.updated` event.** Deferred: out of Phase 1 scope; clients
  re-read. It can be added later without changing this decision.
