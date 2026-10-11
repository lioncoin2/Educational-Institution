# P8 — Live media verification matrix (Sprint 8)

**Scope.** The Flutter live-media experience (ADR 0030): the LiveKit adapter
(`app/lib/data/media/livekit/`), the media controller
(`app/lib/features/live/state/live_media_controller.dart`), and the Live Media
Panel (`app/lib/features/live/widgets/live_media_panel.dart`). For each lifecycle
path this records what is verified, by which kind of test, whether that test
actually ran, the evidence, and any limitation with its next step.

This document is deliberate about the line between **mocked** verification
(deterministic Dart fakes — unit/widget, no SDK, no network) and **real-media**
verification (a real LiveKit 1.13.7 server reached over a real browser WebRTC
stack). A fake is never described as a real-media test, and no screen-capture
claim is made that the harness cannot support.

## Test kinds

- **unit** — Dart VM against deterministic fakes. `flutter test`.
- **widget** — Flutter widget test against deterministic fakes. `flutter test`.
- **real-E2E** — `.github/workflows/live-e2e.yml`: compiled Flutter Web in
  headless Chrome (fake **microphone** device) against a Dockerised backend in
  `LIVE_MEDIA_PROVIDER=livekit` mode + real LiveKit 1.13.7, with ephemeral
  per-run credentials. Dispatched per media commit (`gh workflow run
  live-e2e.yml`); it also runs on PRs touching `app/lib/features/live/**` or
  `app/lib/data/media/**`.
- **browser-manual / device-manual** — interactive steps (end of this doc), NOT
  run in CI. Headless Chrome cannot acquire a real **screen-capture** source,
  and this repository has no interactive-browser or physical-device harness
  (ADR 0030: native is a separate future phase; there is no mobile CI).

## Matrix

| # | Behavior (Phase-2 path) | Kind | Ran? | Evidence | Limitation / next step |
|---|---|---|---|---|---|
| 1 | Explicit join → backend grant → LiveKit connect | widget + real-E2E | yes | `live_media_panel_test` (tap `live-audio-join` → one `/join` for the session id → connecting); E2E `🎉 1 test passed` with a real `RoomConnectedEvent`, `serverVersion: 1.13.7`, ICE `…StateConnected` | — |
| 2 | Mic permission + publish → mute → unmute → stop | widget + unit + real-E2E | yes | panel: enable/disable reflect the **SDK-confirmed** command (the publish future resolving, only then "on"), denied → recoverable + stays off, pending blocks a duplicate; `livekit_room_port_test` forwards mic; E2E toggles mic when the grant permits | UI reflects the **command-confirmed** publish, not a live track subscription; an SDK-driven mute (server mute, device loss) is not surfaced — ADR 0030 roster/speaking future slice |
| 3 | Screen authority → capture → publish → stop | widget + unit | **partial** | panel: presenter-only gating, start/stop, cancel/failure recoverable; `livekit_live_media_client_test` refuses without a grant (`screen_not_permitted`); port forwards screen with `captureScreenAudio:false` | **real screen CAPTURE is NOT verified** — headless Chrome has no screen source. `me.presenting`/a grant is never treated as proof of a publishing track. See browser-manual. |
| 4 | Presenter authority revoked while sharing | widget | yes | panel: revoke → capture stopped (client told `false`) **and** re-grant shows capture OFF (no stale "sharing") — D1 below; backend also drops the track server-side (`updateCapabilities` → LiveKit) | — |
| 5 | Removal / room deletion / duplicate identity / remote disconnect | unit + real-E2E (connect path) | yes | `livekit_disconnect_reason_test` mapping; `live_media_controller_test` terminal-reason + roomDeleted-rejoin; panel shows each reason + an explicit rejoin; adapter filters our own `clientInitiated` | a remote kick / duplicate-identity is not *forced* in the E2E (single participant); mapping + handling are unit-verified |
| 6 | Network interruption → reconnecting/reconnected → UI | unit + widget | yes | adapter maps `RoomReconnecting`/`Reconnected`→signals; controller propagates; panel disables controls while reconnecting and **preserves** mic/screen across the transient | a real mid-call network drop is not injected in CI; the SDK-event→state path is unit-verified |
| 7 | Leave / navigate away / change session / dispose | unit + widget | yes | explicit leave → idle + client disconnect; **dispose now disconnects the client** (D2); the controller is keyed on the session id (autoDispose family) so one session cannot drive another's media | resolves ADR 0030's open "dispose → disconnect?" toward release; background audio is intentionally not kept (no UI surface) |
| 8 | Partial connect/capture failure + cleanup | unit + widget | yes | adapter: half-open room released on connect failure, an opener failure leaves no room (new test); `_teardownResources` attempts every step then rethrows the first; client connect-failure → `failed` | — |
| 9 | Retry / rejoin without duplicate rooms/tracks/listeners/stale state | unit | yes | adapter: `_room` cleared first, the orphan is never re-torn, a reconnect opens a fresh room; controller `_generation` stale-guard + single-flight `/join` | — |

## Fixes implemented this sprint

- **D1 — widget (`live_media_panel.dart`).** The connected card resets its
  screen-share control to **off** when presenter authority is revoked
  (`me.presenting` true→false). Before, the local `_screenOn` survived a
  revoke+re-grant and the re-shown toggle falsely read "sharing active" though
  capture had stopped. Covered by `live_media_panel_test` ("re-granting
  presenter after a revoke shows capture as off").
- **D2 — controller (`live_media_controller.dart`).** `onDispose` now also
  disconnects the media client. Before, disposing (navigate away / change
  session) cancelled the state subscription but left the room connected — a
  stranded live microphone, and on return a fresh controller would read the
  client's lingering `connected` while the panel showed the mic off. Covered by
  `live_media_controller_test` ("disposal disconnects the client"). This is the
  resolution of ADR 0030's open dispose decision.

## Known limitations & next steps

- **Real screen capture (path 3).** Not verifiable in the current CI harness
  (headless Chrome provides a fake mic via `--use-fake-device-for-media-stream`
  but no `getDisplayMedia` source). Verified instead by the browser-manual steps
  below. No automated test asserts a published screen track.
- **Mid-session presenter grant (D3) — RESOLVED in Sprint 9.** The adapter no
  longer trusts only the join ticket: it listens to the SDK's
  `ParticipantPermissionsUpdatedEvent` for the local participant and relays the
  live `canPublishScreen` as a `LiveKitCapabilities` signal, so `_screenAllowed`
  tracks the server's live authorization. A presenter granted the slot **after**
  joining can now share with no reconnect; a revoke re-blocks it and stops any
  active capture. The client-side pre-check (deterministic, SDK-free) is kept —
  it now reflects the LIVE capability, not the stale join flag. See the Sprint 9
  section below.
- **Live track mute (path 2).** The UI shows command-confirmed publish state,
  not the SDK's live track state; an externally-driven mute is not reflected.
  Resolved by the future roster/speaking slice (ADR 0030).

## Sprint 9 — live capability synchronization (the D3 fix)

**Root cause.** `LiveKitLiveMediaClient._screenAllowed` was set once, from the
join grant's `screen` flag, and never updated. The backend, on a presenter
grant/revoke, pushes new publish capabilities to LiveKit (`updateCapabilities`
→ `updateParticipant`) WITHOUT reissuing the Flutter grant, so a participant
granted presenter after joining stayed locally blocked.

**Fix (adapter + client; no reconnect, no backend change, no seam change).**
- `SdkLiveKitRoomPort` subscribes to the SDK `ParticipantPermissionsUpdatedEvent`
  for the LOCAL participant and emits a `LiveKitCapabilities(canPublishScreen)`
  signal (plus an initial one on connect). `canPublishScreen` comes from
  `screenPublishAllowed`, the backend's own rule — can-publish AND (no explicit
  sources ⇒ all, or the screen source `3` is listed).
- `LiveKitLiveMediaClient` updates `_screenAllowed` from that signal and, on a
  genuine allowed→denied transition, stops any active capture (best-effort,
  server-driven). A grant NEVER auto-starts capture (explicit intent only); the
  authorization (`screenAuthorized`) stays distinct from the capture state.

**Verification.**

| Scenario | Kind | Ran? | Evidence |
|---|---|---|---|
| The capability RULE (empty⇒all, screen listed, canPublish gate) | unit | yes | `livekit_room_port_test` — `screenPublishAllowed` |
| A `LiveKitCapabilities` signal surfaces on the port stream | unit | yes | `livekit_room_port_test` |
| Grant while connected → authorized, no reconnect; start then allowed | unit (fake port) | yes | `livekit_live_media_client_test` |
| A grant never auto-starts capture | unit | yes | same |
| Revoke → active capture stopped + re-blocked | unit | yes | same |
| Duplicate / no-change / out-of-order updates idempotent (one stop) | unit | yes | same |
| Server/SDK refusal despite authorization → surfaced, token not leaked | unit | yes | same |
| Authorization dropped on disconnect; new grant resets it (session change) | unit | yes | same |
| Microphone unaffected by capability changes | unit | yes | same |
| **Real grant→revoke over LiveKit** (claim presenter → `screenAuthorized` true → stop → false), no reconnect | **real-E2E** | yes (dispatched) | `livekit_web_e2e_test` extension; observed via the live participant permission, NO screen capture |

**Real vs mocked.** Every unit row uses deterministic fakes (no SDK). The last
row is the ONLY real-media proof: it drives a real backend presenter
grant/revoke and watches the real SDK permission reach the client — but it does
NOT publish a screen track (headless Chrome has no screen source), so real
screen CAPTURE remains the manual check B1 below.

## Manual verification (NOT executed in CI)

These are the checks the automated harness cannot perform. They require a real
backend in `LIVE_MEDIA_PROVIDER=livekit` mode and a LiveKit server (a local
`infra/compose*.yaml` stack is sufficient — never production).

### B1 — Browser screen capture (interactive Chromium)

1. Start the local stack and a backend in LiveKit mode; sign in as a user who
   can moderate the session.
2. Start a live session and **claim the presenter slot** (so the join grant
   carries `screen:true`), then open the live screen and tap **الانضمام إلى
   الصوت** (join).
3. Tap **بدء مشاركة الشاشة**; in the real browser picker, choose a window/screen
   and confirm.
   - **Expected:** the control shows **مشاركة الشاشة مُفعّلة**; a screen-share
     track is actually published — confirm in the LiveKit room (e.g. server
     logs / another participant / `livekit-cli`), NOT merely from the toggle.
4. Tap **إيقاف مشاركة الشاشة** → the track is unpublished.
5. Have a moderator revoke the presenter slot while sharing → capture stops, the
   control disappears, and the server shows the track gone.
6. Cancel the browser picker instead of choosing a source → the control returns
   to off and shows **تعذّرت مشاركة الشاشة…** (recoverable).

### B2 — Microphone permission (interactive browser, real prompt)

1. Join audio, tap **تشغيل الميكروفون**, and **deny** the browser permission
   prompt → the control stays off and shows **تعذّر تشغيل الميكروفون…**.
2. Grant it on a second attempt → the control shows **الميكروفون مُشغَّل** and a
   mic track is published (confirm server-side).

### D1 — Physical device (Android / iOS)

No mobile CI or device lab exists (ADR 0030 — native is a separate future
phase), so this is unverified. When a device is available: build the app for the
platform, repeat B1/B2, and additionally verify the OS-level permission prompts,
the microphone foreground service (Android), and the ReplayKit broadcast
extension (iOS). Do **not** record a device result until it is actually run.
