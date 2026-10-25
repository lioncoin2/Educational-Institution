# Architecture Decision Records

One file per decision that is expensive to reverse.

**Format.** Context → Decision → Consequences → Alternatives considered. The
last section is the one that matters in two years: it is the record of what was
already thought about, so a decision is only reopened with new information
rather than with an argument that was already had.

**Status** is one of `Proposed`, `Accepted`, `Superseded by NNNN`, or `Deprecated`. An ADR
is never edited to change its decision — a new one supersedes it. The record is
the history, not the current state.

From 0022 on, when a later ADR replaces only part of an earlier one, the
earlier ADR stays `Accepted`, marked "superseded in part by NNNN". It gains
only that status line and a note at each replaced decision pointing to its
successor; its text is otherwise left as decided. The first such pair is
0018 → 0022. 0021 → 0022 is the second: 0021's decision 7 counted the lag
filter's `statesOf` in a community-chat page's cost. Since then: 0020 → 0023
(its decision 8), 0024 → 0025, 0019 → 0028 (0019's provisional presenter
design), and 0016 → 0039 (0016's "a community has no `kind`", decisions 1 and 3;
0039 also extends 0017). Earlier partial supersessions (0016–0021 over 0003, 0005, 0006, 0009,
0011 and 0012) are recorded only in the ADR that makes them, as the package note
below says.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-backend-stack.md) | TypeScript and NestJS for the backend | Accepted |
| [0002](0002-modular-monolith.md) | Modular monolith, not microservices | Accepted |
| [0003](0003-rtc-provider-abstraction.md) | Abstract the RTC provider behind a port | Accepted |
| [0004](0004-storage-provider-abstraction.md) | Abstract binary storage behind a port | Accepted |
| [0005](0005-authorization-architecture.md) | Centralized permission + policy authorization | Accepted |
| [0006](0006-event-architecture.md) | In-process domain events, outbox-ready | Accepted |
| [0007](0007-messaging-architecture.md) | One conversation model; references, not payloads | Accepted |
| [0008](0008-drizzle-over-prisma.md) | Drizzle ORM rather than Prisma | Accepted |
| [0009](0009-executable-architecture-rules.md) | Enforce boundaries with dependency-cruiser in CI | Accepted |
| [0010](0010-stateful-sessions-and-rotating-refresh-tokens.md) | Stateful sessions, checked per request, with rotating refresh tokens | Accepted |
| [0011](0011-messaging-v1.md) | Messaging V1: server-ordered, idempotent, membership-first | Accepted |
| [0012](0012-realtime-messaging-transport.md) | Realtime messaging: plain WebSocket, membership decided per event | Accepted |
| [0013](0013-notifications-v1.md) | Notifications V1: a stored inbox, idempotent by the database, delivered by subscribers | Accepted |
| [0014](0014-academic-core-v1.md) | Academic Core V1: academic owns the structure and who is in it | Accepted |
| [0015](0015-academic-structure-reconciliation.md) | Academic structure reconciliation: records the owner's Q35/Q36 answers (hierarchy stays Section→Program→Halaqa — Level retired; «تجويد الحروف» = `dep-tajweed-letters`); supersedes in part 0014's names/count; seed application deferred (Tahajji §7 + non-core sections) | Accepted |
| [0016](0016-communities-module.md) | Communities: a new module owns communities, membership, invitation links and lifecycle | Accepted; superseded in part by [0039](0039-groups-and-channels-chat-mode.md) |
| [0017](0017-community-scoped-authorization.md) | Community-scoped authorization: identity ceilings AND community standing; delegated capabilities; host-only moderation retired | Accepted |
| [0018](0018-community-chat-projection.md) | Community chat: messaging keeps a named, versioned projection of community membership | Accepted; superseded in part by [0022](0022-community-chat-delivery-check.md) |
| [0019](0019-community-scoped-live-sessions.md) | Community-scoped live sessions: Postgres truth, level-triggered LiveKit convergence, a presenter slot, narrow RTC ports | Accepted; superseded in part by [0028](0028-screen-sharing-two-presenters-and-delegated-student-access.md) |
| [0020](0020-attendance-snapshots.md) | Attendance snapshots are observations owned by a new attendance module (implementation held) | Accepted (implementation held); superseded in part by [0023](0023-attendance-authorization-and-policy.md) |
| [0021](0021-cross-cutting-rules-for-new-modules.md) | Cross-cutting rules for the new modules: events in contracts, journals, durability classes, the realtime transport matrix, protocol v1 growth, `FailureKind 'unavailable'`, executable guards | Accepted; superseded in part by [0022](0022-community-chat-delivery-check.md) |
| [0022](0022-community-chat-delivery-check.md) | Community chat: every recipient page is checked against Communities, and a divergence rebuilds the projection (replaces 0018's delivery shortcut) | Accepted |
| [0023](0023-attendance-authorization-and-policy.md) | Attendance authorization uses academic relationship AND community standing (supersedes 0020's decision 8); records Q8/Q12/Q69; notifications deferred to P10/Q67 (policy now recorded in [0024](0024-notification-policy-p10.md)) | Accepted |
| [0024](0024-notification-policy-p10.md) | Notification policy for P10: the initial, reversible set of community/live/attendance facts that notify and on which channels (answers Q67 and the P10 scope of Q28); academic deferred; delivery stays best-effort (T2/outbox gate of 0021 preserved) | Accepted; superseded in part by [0025](0025-defer-persistent-live-session-start-notifications.md) |
| [0025](0025-defer-persistent-live-session-start-notifications.md) | Defer persistent live-session-start notifications: `LIVE_SESSION_STARTED` stays a realtime-only Live event (existing relay); no persistent notification, dispatcher, outbox, broadcast model, or channel-default logic is built (supersedes in part 0024's `live.session.started` persistence/channel row) | Accepted |
| [0026](0026-live-participant-control-and-media-reset.md) | Moderator-commanded live participant control: a kick that is not a ban, and a shared media reset (Q64); over the existing RTC ports and epoch mechanism, no new capability | Accepted |
| [0027](0027-no-hidden-live-listeners.md) | No hidden live listeners: every admitted participant is visible in the roster (Q59); `hidden` is an enforced-`false` invariant, no spectator/observer role | Accepted |
| [0028](0028-screen-sharing-two-presenters-and-delegated-student-access.md) | Screen sharing: up to two concurrent presenters, counted under the session lock, with session-scoped delegated student access (Q56); supersedes in part 0019's provisional presenter cap and self-claim-only rule | Accepted |
| [0029](0029-community-message-moderation.md) | Community message moderation: delete to a tombstone, a 7-day audited review, then retention; authority is the delegable `community.messages.moderate` under `communities.moderate`, never identity's `messaging.manage` (Q51/Q23) | Accepted |
| [0030](0030-flutter-livekit-media-client.md) | Flutter LiveKit media client (P7b): the app's RTC adapter behind the `LiveMediaClient` seam, `livekit_client` pinned and adapter-confined | Accepted |
| [0031](0031-architecture-navigation-index.md) | A generated, code-derived architecture index, a root `CLAUDE.md` entry point, and a project-wide Flutter layering test; freshness enforced in CI, no new dependency | Accepted |
| [0032](0032-discovery-membership-attendance-separation.md) | People discovery is not membership, authorization, or attendance: owner/admin-only `GET /people`, community-scoped candidate search on `community.members.invite`, and the explicit add re-authorizes; academic relationships and attendance ([0023](0023-attendance-authorization-and-policy.md)) stay independent; Q50 and Q22 stay OPEN (formalizes Sprint 24) | Accepted |
| [0033](0033-community-halaqa-link-and-member-list-visibility.md) | Optional community→halaqa link — inert metadata, existence-validated through academic's read-only `ACADEMIC_RELATIONSHIPS` contract, gated on `communities.manage` (Flutter UI on `me.canManageHalaqa`); a conversation's member list is owner/admin-only (`users.manage`); the teacher roster is current students only (Q50 link / Q22 / Q31) | Accepted |
| [0034](0034-q50-enrollment-sourced-membership-and-derived-capabilities.md) | Q50 enrollment-sourced membership & derived capabilities: investigated and **deferred** — policy is not owner-approved and two additive model gaps (membership and capability-grant have no derived `source`) block safe implementation; propagation pattern is ready; the inert link + enrollment are regression-tested; Q50 stays OPEN | Deferred (status superseded by 0035) |
| [0035](0035-community-membership-governance-separation.md) | Community membership governance (owner decision, Policy A–E): academic enrollment never creates or removes community membership; membership stays explicit (`source` ∈ {ADDED, INVITATION}); ordinary membership grants no capabilities; enrollment/membership/invitations/grants/attendance/messaging stay separate. Resolves the Q50 question 0034 left open (decided **no**); no code/schema change — the model already enforces it (regression-tested). **Q50 fully resolved** | Accepted |
| [0036](0036-quiet-hours-and-conversation-mute.md) | Quiet hours and per-conversation mute (owner decision, Q6/Q24): institution-level quiet-hours window + timezone with a **full** user override (inherit / disable / custom), evaluated DST-aware in the user's timezone or the institution's as fallback; **push only** (the inbox stays lossless, realtime untouched); per-conversation mute keyed on the notification's stable conversation target; **no urgent bypass**. Institution policy is `settings.manage` (owner-only), user settings/mutes are self-scoped; no new permission. Migration 0022 (additive); push stays a stub. Q6/Q24 remain OPEN in part | Accepted |
| [0037](0037-trial-environment-and-explicit-fake-media.md) | The Trial is a deployed environment (`NODE_ENV=trial`): staging's full configuration baseline (every secret required, no placeholder, ≥ 32 bytes, kept apart; `DATABASE_URL`/`REDIS_URL` required); the fake media provider is a declared choice (`LIVE_MEDIA_PROVIDER=fake`), refused in production; `TRUST_PROXY` named in every deployed environment, a malformed value refused | Accepted (2026-10-20, owner — register §29) |
| [0039](0039-groups-and-channels-chat-mode.md) | Groups vs channels as a community `chat_mode` (GROUP_OPEN / GROUP_RESTRICTED / CHANNEL), posting decided by capability (Phase 5, owner-approved): **amends ADR 0016 in part** (reverses "a community has no `kind`") and **extends ADR 0017** (a membership basis for posting in an open group); the chat stays a CHANNEL conversation (0018 intact). A new group is open to member posting (`POSTING_MEMBER_RULE`, member ceiling, membership basis — no per-member grant); an admin restricts/restores via the new delegable `community.chat.manage`; a channel and a restricted group publish only to owner + `community.chat.post` grantees; LOCKED still blocks everyone. `me.canPost` is the authoritative composer signal; a `community.chat_mode.changed` event rides the existing `community.access.changed` realtime frame. Migration 0025 (additive; existing communities default GROUP_RESTRICTED = current behavior, nothing converted). Resolves Q41 (the kind column) + Q51 (posting half) | Accepted (2026-10-20, by the owner) |
| [0040](0040-owner-command-center-reporting-registry.md) | Owner Command Center v1 (owner-directed): activates the `reporting` seam as the widget **registry** its contract describes — `GET /reporting/command-center` (edge `reports.read`) returns the widgets the viewer may see, each resolved server-side and hidden unless the viewer holds its `requiredPermission`; providers are bound inside `ReportingModule` (no `multi:true`, no foreign-token export) and read other modules only through `contracts/`. v1 widgets are **facts only**: communities (total + accepting, via `listHeads`) and academic structure (ACTIVE sections/programs/halaqat, via a new read-only `ACADEMIC_STRUCTURE_SUMMARY` reusing `catalogue()` — no migration). No new permission, no invented metric/threshold; accounts/live/attendance are future providers, present/absent stays Q70-gated | Accepted (2026-10-20, owner — register §29) |
| [0041](0041-mass-publish-to-communities.md) | Mass publishing (owner-directed): `POST /messaging/communities/publish` (edge `messaging.send`) posts one notice/file/image/voice recording to several communities at once, each authorized on its own `community.chat.post` through the existing `MessageSender` path — **no** new permission, **no** migration, **no** notification change. Partial failure is a per-community outcome (posted/already_posted/forbidden/not_found/locked/over_capacity/rate_limited/unavailable), never a thrown batch; a deterministic per-community `clientMessageId` from `clientBatchId` makes retry idempotent (no duplicates). Distinct from «نظام الضخ» (academic move, register §22, still EXCLUDED); resolves roadmap domain 3's broadcast "Next action". Also adds the command-centre actions registry (0040 follow-on) surfacing `publish.communities`, and an accounts summary widget via a new read-only identity `ACCOUNT_DIRECTORY_SUMMARY` (gated `users.manage`, no migration) | Accepted (2026-10-20, owner — register §29) |
| [0042](0042-operations-scheduled-lessons.md) | Operations scheduling (owner-directed, approved D1–D5): the first `operations` behaviour — `/operations/lessons` CRUD for **individual dated lessons**, one per halaqa. A lesson stores its wall clock + the **IANA timezone captured at creation** + the resolved `scheduled_at` instant, so a later institution-timezone change never moves it. A pure DST resolver **rejects** spring-forward gaps and resolves fall-back folds to the **earlier** instant; new/rescheduled lessons must be strictly future (injected `Clock`). New capability **`operations.schedule_manage`** (OWNER/ADMIN only; reads gated too — no id enumeration); halaqa existence via academic's `ACADEMIC_RELATIONSHIPS.halaqaExists`. Cancellation is an auditable state transition (never a delete); create is idempotent via `clientRequestId`. **No** recurrence/attendance/notification/conflict policy (conflict is a separate owner decision). Migrations 0026 (table) + 0027 (permission seed). Adds a neutral `institution.timezone` deployment config, decoupled from the owner-rejected quiet-hours timezone (conflict reported) | Accepted |
| [0038](0038-identity-and-community-profile-media.md) | Profile pictures and community profile editing on the Files module (Phase 1): a picture is a Files `IMAGE` asset referenced by id (never a URL, no second store); the user's avatar is stored on `identity.users` and set through Files via a narrow `ACCOUNT_AVATAR_WRITER` contract (identity cannot import Files — the dependency is files → identity); it travels with the name through `AccountSummary`, so a message sender's picture rides the same resolver (`PersonView`); a community gains `description`, a picture, and a new delegable capability `community.profile.edit` (ceiling `communities.moderate`, oversight `communities.manage`, gate `always`). Migrations 0023/0024 additive. Owner-open: whether a minor's/student's self-set picture should be as visible as their name (Q22/Q31) | Proposed |
| [0043](0043-pinned-messages.md) | Pinned messages (community chat): one server-authoritative pin per conversation stored as `conversations` columns (migration 0028; FK `ON DELETE SET NULL`; consistency CHECK), reusing `community.messages.moderate` (no new permission); only a live message is pinnable and a later tombstone keeps the pin (banner «رسالة محذوفة»); ordering is a monotonic `pin_version` (migration 0029) bumped only on a real change, carried by a content-free `message.pinned` realtime event, with a strictly-newer client acceptance rule + reconnect refresh. Reactions EXCLUDED; direct-chat pin is an explicit reported gap. **Back-documents the implemented design; owner-accepted 2026-10-20 (register §29)** | Accepted (2026-10-20, owner — register §29) |
| [0044](0044-community-role-policy-revision.md) | Community role policy revision (owner A–C, 2026-10-25): supervisors join teachers inside the `live.moderate`/`live.speak` and `communities.moderate` **ceilings** (migration 0032, data only) — starting a broadcast and adding members still need the community's basis (owner standing or a `community.live.start` / `community.members.invite` grant there); no general role bypasses it, the institution OWNER included; oversight transfer becomes **recovery only** — allowed only when the owner's account is not ACTIVE or lost the ownership ceiling (`403 communities.owner_can_still_act` otherwise), `me.operations` agreeing. Supersedes in part Q1/Q42/Q43/Q44/Q54 defaults and ADR 0035 B | Accepted (2026-10-25, owner — register §30) |
| [0045](0045-author-message-edit-and-delete.md) | Authors edit (text/caption only, `PATCH …/messages/:id`) and delete their own messages in every conversation kind; moderators delete in community chats (ADR 0029), never edit; conditional update never revives a tombstone (409), delete wins races; ids-only `messaging.message.edited` → realtime `message.edited` rendered per member; no migration, no revision history | Accepted (2026-10-25, owner — register §30) |
| [0046](0046-notification-content-for-authorized-recipients.md) | In-app notifications show sender, conversation and a 140-character preview to a recipient who may read it **now**, resolved at read time by messaging's new `MESSAGE_NOTIFICATION_CONTEXT` (removed/revoked/deleted → nothing more; edited → new text); nothing stored or evented; push/lock screen stays content-free (ADR 0013 decision 9 stands). Supersedes in part ADR 0013 and Q24's in-app line | Accepted (2026-10-25, owner — register §30) |
| [0047](0047-live-session-chat.md) | A live session's own chat: Live's table `live_chat_messages` + `live_sessions.chat_locked/chat_lock_version` (migration 0033, additive); participants read and post by default, moderators lock/unlock (audited) and still post; lock decided at the write (FOR SHARE vs the lock's UPDATE); ids-only events, `live.chat.message`/`live.chat.changed` frames to session participants only via a principal-less `LIVE_CHAT` reader; LiveKit data channel stays disabled; nothing deleted | Accepted (2026-10-25, owner — register §30) |
| [0048](0048-live-participant-pictures.md) | The live room shows participants' real pictures (C15): `GET /live/sessions/:id/participants/:userId/avatar` — identity's reference, Files' 5-minute link — only for people the room already names to the caller (self, host, presenters; anyone eligible for a moderator); Live → Files contract edge; host on the stage; initials otherwise | Accepted |
| [0049](0049-live-room-reactions.md) | The live room's four reactions (❤️ 👍 👏 😊): `POST /live/sessions/:id/reactions` (202), ephemeral (no table, no audit), `live.reaction` frame with the kind alone to the session's other participants; not messaging reactions (still excluded); LiveKit data channel stays off | Accepted |
| [0050](0050-live-speaking-offer-and-room-reset-feedback.md) | `me.canRaiseHand` false for whoever already speaks by right (raise command unchanged, Q54); a room reset keeps its ADR 0026 scope but the app now says what it changed (re-join note, mic/screen hints), reports `reset:false` honestly, and asks once | Accepted |

> **`Proposed`** (added 2026-09-23): a design under review, with nothing
> implemented. It becomes `Accepted` when the user accepts it (dated in the
> ADR), or it is withdrawn. 0016–0021 were accepted by the user on
> 2026-09-23. Acceptance does not by itself start implementation: 0016–0019
> and 0021 are implemented in phases, and 0020's implementation is held until
> the attendance policy questions are answered (the Q40 ruling in
> [0016](0016-communities-module.md)).
>
> **0022 was implemented before it was accepted.** Review of P4 found that
> 0018's decision 9 let delivery trust a stale projection after an
> independent restore of Communities. The P4 brief's §19 forbids that, so
> the fix landed with P4's review fixes while 0022 was still `Proposed`.
> The user accepted 0022 on 2026-09-24 and kept the implementation. 0018
> stays `Accepted` for everything 0022 does not replace.
>
> **0037 was accepted 2026-10-20 (register §29); its code is not yet merged.** The Trial remediation
> (2026-10-18) wrote and tested the code for 0037 in an **uncommitted** patch. The owner accepted 0037 on
> 2026-10-20, authorizing the Trial runtime contract (`NODE_ENV=trial` + `LIVE_MEDIA_PROVIDER=fake`); the
> implementing code is committed and deployed only with the first web-first Trial release, which is a
> separate, still-pending state-changing step.

**0015 is reserved.** The academic reconciliation names ADR 0015 for its
structure change (`academic-reconciliation.md:410`, `:490`, `:506`), which
waits on the owner's answers to Q35 and Q36. The communities, live and
attendance package therefore starts at 0016 rather than renumbering that
reservation.

**0016–0021 are one package**, described in
[communities-live-attendance.md](../communities-live-attendance.md).
Accepted on 2026-09-23, they amend or partly supersede 0003, 0005, 0006,
0009, 0011 and 0012; each new ADR says exactly which part. Those ADRs are
not edited and stay `Accepted`: a partial supersession is recorded in the ADR
that makes it.
