# 0036 — Quiet hours and conversation mute: institution policy with user override, push-only (owner decision)

**Status:** Accepted — 2026-10-13 (owner decision, Sprint 35). Builds on the delivery model of
[ADR 0013](0013-notifications-v1.md) (a stored inbox; channels decided per notification) and the
P10 notification policy of [ADR 0024](0024-notification-policy-p10.md); it changes neither. It
implements the quiet-hours and per-conversation-mute parts of [Q24](../open-questions.md#q24--notifications-push-provider-lock-screen-previews-quiet-hours-mute)
and the quiet-hours part of [Q6](../open-questions.md#q6--who-may-message-whom). It does **not**
resolve either question in full (see *What stays open*).

## Context

The owner approved, in principle, an institution-level quiet-hours policy with a user override, and
per-conversation mute (Sprint 34 decision sheet). Two policy points were left unspecified and are
genuinely unsettled by existing governance; before implementing, the owner was asked and answered:

1. **Direction of the user override.** Does a user's own quiet-hours setting weaken/disable, or only
   strengthen, the institution window? The owner chose **full override**: a user's setting replaces
   the institution window for them — they may widen it, narrow it, or disable quiet hours entirely.
2. **Missing or invalid user timezone.** No per-user timezone existed before this sprint, and
   [Q12](../open-questions.md#q12--timezone-and-academic-calendar) settles a timezone only for
   attendance, not for notifications. The owner chose **fall back to the institution timezone** —
   never a guessed or hard-coded zone; with no institution policy to borrow a zone from, quiet hours
   simply do not apply.

## Decision

- **Quiet hours suppress PUSH only.** The in-app record is always stored (the inbox stays lossless,
  per ADR 0013), and realtime delivery is untouched. Quiet hours hold back the push to a device in a
  nightly window, by the clock.
- **Institution policy, user override (full).** The institution may set one window + timezone
  (enabled/disabled). A person may inherit it, disable quiet hours for themselves, or set their own
  window. The person's choice fully replaces the institution window for them.
- **Evaluated in the user's timezone, DST-aware.** The window is read in the user's IANA timezone if
  set and valid, else the institution's; windows may run overnight. A fixed offset ("+03:00") is not
  a timezone here — a wall-clock policy needs a named zone, which alone is DST-correct.
- **Per-conversation mute suppresses PUSH only, for one conversation.** A mute is keyed on the
  notification's own typed target (`contracts/targets.ts`): a `conversation` target carries a stable
  `conversationId`. Direct messages, groups, channels and a community's chat are all one conversation
  kind and mute uniformly. A notification with any other target (a community-membership fact, a live
  room, a profile) has no conversation and is never changed by a mute. A mute removes no membership,
  revokes no capability, changes no access, disables no category, mutes no other conversation, and
  never prevents the in-app record from being stored. Unmuting restores push.
- **No urgent / always-deliver bypass.** Suppression never branches on the notification's type or
  importance. Until a separate, explicit policy defines an urgent class, every suppressed push is
  suppressed the same way.
- **Authorization — narrow, no new permission.** The institution policy is read and changed only with
  `settings.manage` (owner-only, the same authority as every other institution setting), on a separate
  `InstitutionNotificationSettingsController`. A person's own timezone, quiet-hours choice and mutes
  are authenticated-and-self-scoped on `NotificationsController`, exactly like preferences — every use
  case acts on the caller's own id, and no request can name another account. No permission is minted
  and no administrator's reach is widened; academic enrollment, community membership and every
  authorization policy are unchanged.
- **The institution's actual schedule, override rules beyond direction, and any urgent policy are NOT
  invented here.** The institution configures its own window; this ADR defines only the mechanism and
  the two owner-answered policy points.

## Mechanics (implemented in Sprint 35)

- **Migration 0022** (`drizzle/0022_q6_quiet_hours_and_conversation_mutes.sql`), additive, three
  tables owned by notifications: `institution_notification_settings` (a singleton row, enforced by a
  CHECK), `user_notification_settings` (one row per person; mode ∈ INHERIT/DISABLED/CUSTOM, a custom
  window carries both bounds), and `conversation_mutes` (one row per person+conversation). Account and
  conversation ids are opaque — no foreign key into another module's tables, like the rest of
  notifications.
- **The suppression is decided once per dispatch** by `PushSuppressionGate` (`application/push-suppression.ts`)
  and recorded in the `channels.push` flag the `notifications.notification.created` event already
  carries. The dispatcher sets `push = category-push AND not(quiet hours) AND not(muted)`; it never
  touches `store` (unconditional) or `realtime`. `PushDelivery` already sends only when `channels.push`
  is true, so no change to delivery was needed. (This is where Q24 anticipated a `PushDelivery`
  filter; placing it at the dispatcher's decision keeps the whole push decision in one event flag.)
- **Pure, testable evaluation** in `domain/quiet-hours.ts` (timezone validation, overnight/DST-aware
  containment via the built-in `Intl`, override resolution — any ambiguity resolves to "deliver",
  since the record is in the inbox regardless) and `domain/conversation-mute.ts`.
- **Push remains a stub.** No real provider is integrated (ADR 0013 / Q24 stand): `LoggingPushProvider`
  is unchanged and sends nothing. Suppression is verified through the `channels.push` decision and the
  stored record, not by observing a device — a real FCM/APNs adapter would consume the same flag
  unchanged. This is the documented limitation of the sprint.

## How this is verified (in source)

- Push-only, record kept, realtime untouched: `application/push-suppression.spec.ts`,
  `application/notification-dispatcher.spec.ts`; end-to-end on Postgres in
  `test/integration/notifications-postgres.spec.ts`.
- Overnight, timezone fallback, DST (the same UTC instant decided differently across a DST change),
  override precedence, missing/invalid timezone, no-urgent-bypass: `domain/quiet-hours.spec.ts`.
- Mute scoping (one conversation, one person, non-conversation targets unaffected), idempotency,
  unmute restores: `domain/conversation-mute.spec.ts`, `application/conversation-mute.spec.ts`.
- Institution authz (owner-only; teacher and student refused), self-scope, API validation:
  `test/api/notifications.api.spec.ts`; the edge permission is pinned in
  `test/architecture/authorization.spec.ts`.
- Schema constraints and no foreign keys out: `test/integration/notifications-postgres.spec.ts`.

## Consequences

- Push becomes quieter and per-conversation controllable without any loss to the inbox or to realtime.
- A real push provider, when added, needs no change here: it reads `channels.push`.
- Each person now has a timezone for notifications — the first per-user timezone in the system. It is
  used only to read quiet hours; it does not change attendance (Q12) or any display elsewhere.

## Alternatives considered

- **Override only strengthens the institution window.** Rejected by the owner in favour of full
  override. Because only push is suppressed and the record is always stored, a user disabling their
  quiet hours only receives more push to their own device — no safeguarding or governance risk.
- **Guess or hard-code a timezone when the user's is missing.** Rejected: a guessed zone is exactly
  the kind of silent default this project refuses. Falling back to the institution's declared zone is
  explicit and DST-correct; with no institution zone, quiet hours do not apply.
- **Suppress realtime (or in-app) as well on a mute.** Rejected for now: the inbox must stay lossless,
  and realtime only updates an already-open client. Mute matches quiet hours — push only. Widening it
  is a one-line change behind a future decision.
- **A `PushDelivery`-side filter (as Q24 sketched).** Equivalent, but it would re-load settings per
  delivery; deciding once in the dispatcher and recording it in the event flag is simpler and is what
  the realtime relay and push already consume.

## What stays open

- **Q24** — the push *provider* and lock-screen *preview* policy are unchanged and still open; only
  quiet hours and mute are built.
- **Q6** — whether students may message each other or a teacher, the parent role, and supervisor
  visibility stay open; only the quiet-hours part is addressed.
- **Urgent / always-deliver notifications** — undefined by design; a separate policy + ADR is required
  before any bypass exists.
