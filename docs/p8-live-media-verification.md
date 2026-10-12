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
| 3 | Screen authority → capture → publish → stop | widget + unit + **real-E2E** | **yes (Sprint 13)** | panel: presenter-only gating, start/stop, cancel/failure recoverable; `livekit_live_media_client_test` refuses without a grant (`screen_not_permitted`); port forwards screen with `captureScreenAudio:false`; **Sprint 13**: `livekit_two_client_screenshare_e2e_test` acquires a REAL display source (headed Chrome on Xvfb) and publishes a real screen track that a second client receives | real CAPTURE now verified end-to-end (not headless; a virtual X display). Authority is still never treated as proof of a publishing track. See the Sprint 13 section. |
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

- **Real screen capture (path 3) — RESOLVED in Sprint 13.** Now verified
  end-to-end: the screen-share harness runs in HEADED Chrome on an Xvfb virtual
  display (a real X framebuffer Chrome's screen-capture pipeline can capture),
  with `--auto-select-desktop-capture-source` so `getDisplayMedia()` resolves to
  the whole screen without a picker. A real screen track is published by one
  client and received by a second. The browser-manual steps below remain the
  check for the interactive picker / cancel path. See the Sprint 13 section.
- **Mid-session presenter grant (D3) — RESOLVED in Sprint 9.** The adapter no
  longer trusts only the join ticket: it listens to the SDK's
  `ParticipantPermissionsUpdatedEvent` for the local participant and relays the
  live `canPublishScreen` as a `LiveKitCapabilities` signal, so `_screenAllowed`
  tracks the server's live authorization. A presenter granted the slot **after**
  joining can now share with no reconnect; a revoke re-blocks it and stops any
  active capture. The client-side pre-check (deterministic, SDK-free) is kept —
  it now reflects the LIVE capability, not the stale join flag. See the Sprint 9
  section below.
- **Live track mute (path 2) — RESOLVED in Sprint 10.** The UI now reflects the
  SDK's reconciled publication (published-and-unmuted) via the
  `LiveKitLocalTracks` signal, so an externally-driven mute/unmute is shown.
  (Remote-participant roster / speaking indicators remain the future ADR 0030
  slice.)

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

## Sprint 10 — media-state reconciliation

Two consistency gaps from Sprint 9's notes are closed, and microphone
publish-state is now verified over real LiveKit.

**The reconciled model.** A new `LiveMediaPublication { screenAuthorized,
microphoneOn, screenShareOn }` is the single SDK-reconciled truth, exposed by the
client (`publication` + `publications`) and watched by the panel via
`liveMediaPublicationProvider`. It is kept DISTINCT from the connection
(`LiveMediaState`) and from a command's in-flight state (the widget's `_micBusy`
/`_screenBusy`), so the three never duplicate:
- `screenAuthorized` — the live server authorization (`LiveKitCapabilities`,
  from `ParticipantPermissionsUpdatedEvent`).
- `microphoneOn` / `screenShareOn` — the SDK's own `isMicrophoneEnabled()` /
  `isScreenShareEnabled()` (published AND unmuted), fed by a new
  `LiveKitLocalTracks` signal the adapter emits on `LocalTrackPublished`,
  `LocalTrackUnpublished`, `TrackMuted` and `TrackUnmuted` for the local
  participant.

**Defects fixed.**
- *Screen-start / authorization race.* Starting is now enabled only once
  `screenAuthorized` is confirmed, never on `me.presenting` alone; during the
  event-ordering window the control shows a disabled "confirming…" state
  instead of a tap that would be refused.
- *Mic (and screen) UI reflected a command, not the SDK.* The toggles now show
  the reconciled `publication`; a command only drives the in-flight spinner. An
  externally-driven mute (a server mute, a device loss) with no command is
  reflected.

**The six screen-share states** map to what the SDK actually exposes:
not-authorized → authorized-idle → starting (the SDK collapses
capture-acquisition and publication into one command-pending window — it exposes
no separate capture-vs-publish callback; documented) → published (reconciled
`screenShareOn`) → stopping → stopped / failed (the command threw).

| Scenario | Kind | Ran? | Evidence |
|---|---|---|---|
| Capability grant → authorization confirmed → UI start enabled | widget | yes | `live_media_panel_test` (the race test) |
| UI gating during the event-ordering window (disabled "confirming…") | widget | yes | same |
| Mic enable/disable → SDK-reconciled on/off (not the command) | widget | yes | `live_media_panel_test` |
| An external mute (no command) reconciled into the UI | widget | yes | same |
| Revoke while sharing → stop + hide; re-grant shows off (no stale) | widget | yes | same |
| Publication fed by capability + local-track signals; no-change no-churn; reset on disconnect | unit | yes | `livekit_live_media_client_test` |
| `LiveKitLocalTracks` surfaces on the port stream | unit | yes | `livekit_room_port_test` |
| **Real microphone publish → mute reconciliation over LiveKit** | **real-E2E** | yes (dispatched) | `livekit_web_e2e_test` — a real fake-device mic track; `publication.microphoneOn` observed true then false |
| Real capability grant/revoke (Sprint 9 regression) | real-E2E | yes | `livekit_web_e2e_test` |

**Real screen CAPTURE remains unverified in CI** (headless Chrome has no
`getDisplayMedia` source). Microphone publish/mute IS now verified for real (the
fake mic device supports it). Screen capture stays the manual check B1.

## Sprint 11 — remote participant state

The REMOTE participant/media gap ADR 0030 deferred is now covered for presence
+ audio + screen, on the existing reconcile-from-snapshot pattern, integrated
into the roster and matched by identity (= the backend user id —
`rtc-provider.ts`: "Stable per-account identity: the platform user id").

**Model.** `LiveRemoteParticipant { identity, audio, screenSharing }` +
`LiveRemoteParticipants` (keyed by identity), exposed by the client
(`remoteParticipants` + `remoteParticipantChanges`) and watched via
`liveRemoteParticipantsProvider` — DISTINCT from the local `publication`, and
never a second source of identity / moderation / attendance.

**Reconciliation.** The adapter reads `room.remoteParticipants` on every
`ParticipantConnected`/`Disconnected`, `TrackPublished`/`Unpublished`,
`TrackSubscribed`/`Unsubscribed` and (remote) `TrackMuted`/`TrackUnmuted`, and
emits a `LiveKitRemoteParticipants` snapshot. Reading the snapshot, not the
event payload, makes duplicate / out-of-order / stale events harmless: a
departed participant is simply absent, a reconnect snapshot replaces the set,
and the set is cleared on connect and disconnect so a previous room never
lingers. The one SDK listener is disposed on room replacement / disposal
(Sprints 6/10 teardown).

**States exposed (only what the SDK establishes truthfully).**
- Audio (4-state): none / unsubscribed / muted / live — NEVER "speaking" (an
  unmuted track is a publication, not speech).
- Screen: published-and-unmuted (`isScreenShareEnabled()`), NEVER inferred from
  presenter authority.
- Presence: in the set = present; absent = gone.
- NOT exposed: per-remote "reconnecting" (the SDK gives a connection-quality
  metric, not a reliable flag); camera / remote video (no approved contract);
  speaking detection (out of scope).

**Roster integration.** `_HandCard` shows additive live chips — "mic open" /
"muted" / "sharing screen" — for a hand whose `userId` matches a live remote
participant. The presenter badge (authority) and the backend observed-media
hint are unchanged and kept separate.

| Scenario | Kind | Ran? | Evidence |
|---|---|---|---|
| Participant join/leave; a departed one is never shown | unit | yes | `livekit_live_media_client_test` |
| Duplicate / no-change snapshot is not churned | unit | yes | same |
| Audio none/unsubscribed/muted/live rule | unit | yes | `livekit_room_port_test` (`remoteAudioState`) |
| A remote signal surfaces on the port stream | unit | yes | `livekit_room_port_test` |
| Session change / disconnect clears the set | unit | yes | `livekit_live_media_client_test` |
| Roster shows live mic/muted/screen for a matched hand | widget | yes | `live_session_screen_test` |
| Remote set initialises empty over real LiveKit | real-E2E | yes | `livekit_web_e2e_test` — `remoteParticipants.length == 0` (one participant) |

**Harness limitation — RESOLVED in Sprint 12.** Sprint 11's real E2E had ONE
participant, so a real remote join/leave/track event was not verified against a
real peer (only deterministic fakes). Sprint 12 adds a genuine two-client
scenario — see below.

## Sprint 12 — real two-participant E2E

Sprint 11's harness limitation is closed: a genuine TWO-CLIENT scenario now
verifies the remote path against a real LiveKit server.

**Topology.** `app/test/e2e/livekit_two_client_e2e_test.dart` connects TWO
independent production clients (`LiveKitLiveMediaClient` each) to the SAME real
room with DISTINCT backend-authorized identities:
- Client A = the owner/host (the existing token).
- Client B = a second STUDENT, created through the REAL admin API by the
  provisioning fixture: `POST /admin/users` → `…/roles {STUDENT}` (which grants
  `live.join`) → `…/status {ACTIVE}` → `POST /communities/:id/members` →
  `POST /auth/login`. No permission is invented and no rule bypassed; B joins
  the media room through the same `/join` authorization as anyone.

**Verified at the application boundary** (`client.remoteParticipants`, not SDK
internals), each with bounded event-driven waits:

| Behavior | Kind | Ran? | Evidence |
|---|---|---|---|
| Two independent clients, one real room, distinct identities, no duplicate | real-E2E | yes | `livekit_two_client_e2e_test` |
| A observes B (real events → adapter → application state) | real-E2E | yes | same |
| Real remote audio publish → `live` reconciliation on A | real-E2E | yes | same |
| Remote mute → leaves `live`; unmute → returns to `live` | real-E2E | yes | same |
| Remote departure drops the participant within a bounded timeout | real-E2E | yes | same |
| B's LOCAL publication is not confused with A's remote view | real-E2E | yes | same |
| Duplicate / out-of-order / stale idempotency | unit | yes | `livekit_live_media_client_test` (fakes — cannot be forced reliably through the real SDK) |

The audio INPUT may be a fake device in headless CI
(`--use-fake-device-for-media-stream`), but the connection, publication,
subscription and remote events are REAL. The provisioning fixture
(`provision-live-session.ts`) is unit-tested (`provisionParticipant`), and the
workflow runs the whole `app/test/e2e/` directory (single-client + two-client).

**Still not E2E-verified at Sprint 12 (both addressed in Sprint 13 below).**
Remote screen CAPTURE (headless Chrome has no `getDisplayMedia` source), and
per-participant RECONNECT. Sprint 13 resolves screen capture end-to-end; it
investigated reconnect and keeps it as deterministic unit coverage with an
honest "not E2E-verified" status (the SDK exposes no reliable per-remote
reconnecting signal, and a true transport partition cannot be induced
deterministically in the harness).

## Sprint 13 — real browser screen sharing (the path-3 gap closed)

The one gap the whole media programme kept open and documented — "real screen
CAPTURE is NOT verified; headless Chrome has no `getDisplayMedia` source" — is
now closed with a genuine capture, published through the production SDK path and
received by a second independent client, against the real pinned LiveKit 1.13.7.

**The harness (how a real source is obtained).** `getDisplayMedia()` has no
source in headless Chrome, so the screen-share harness runs in its OWN workflow
step in HEADED Chrome on an **Xvfb virtual display** — a real X framebuffer that
Chrome's screen-capture pipeline can actually capture. A CI-only Chrome wrapper
STRIPS flutter's `--headless` (so Chrome runs headed on the Xvfb `DISPLAY`) and
adds `--auto-select-desktop-capture-source="Entire screen"` with
`--use-fake-ui-for-media-stream`, so `getDisplayMedia()` resolves to the whole
virtual screen with no interactive picker. This is **NOT**
`--use-fake-device-for-media-stream` (that fakes a *camera*, never the display):
the published track is a real screen-capture track off Chrome's own pipeline. If
no source is acquired the SDK publish throws and the test FAILS — it never passes
on a fake. The proven connect/audio harnesses are unchanged (still headless) so
there is zero regression risk to them; the screen step is separate and its
execution is independently evidenced in the workflow log.

**Topology.** `app/test/e2e/livekit_two_client_screenshare_e2e_test.dart` — two
independent production clients, one real room, distinct backend identities:
- Client A = the owner/host. It CLAIMS the presenter slot through the real
  backend (`POST /live/sessions/:id/screen-share`, which requires `live.moderate`
  + `live.speak` — the owner holds both), so LiveKit pushes it
  `canPublishSources:[screen]` via `updateParticipant` →
  `ParticipantPermissionsUpdatedEvent` (live, no reconnect). No permission is
  invented and no authorization bypassed — the same path the single-client E2E
  already proves.
- Client B = the second STUDENT (the Sprint 12 fixture). It only OBSERVES.

**The six states are asserted separately and never collapsed:**

| # | State | Where asserted |
|---|---|---|
| 1 | presenter authority | `clientA.screenAuthorized` after claim |
| 2 | server screen capability | the same live SDK permission |
| 3 | a real capture source obtained | implied by (4): publish succeeds only if a source was acquired |
| 4 | a screen track actually published | `clientA.publication.screenShareOn` (local, SDK-reconciled) |
| 5 | the remote receives the track | `clientB.remoteParticipants[A].screenSharing` |
| 6 | remote app state reflects start AND stop | the same, re-checked false after stop |

Explicit anti-conflation assertions: authority alone leaves `screenShareOn` and
the remote `screenSharing` BOTH false (states 1/2 ≠ 3/4/5); A's local share is
never B's local publication, and never surfaces as B's own remote share
(local ≠ remote). Stop reconciles both sides to inactive while A stays connected;
a presenter revoke withdraws authorization with no stale active-share left.

| Behavior | Kind | Ran? | Evidence |
|---|---|---|---|
| Real browser display capture → a real published screen track | real-E2E | yes (dispatched, headed+Xvfb) | `livekit_two_client_screenshare_e2e_test` — `clientA.publication.screenShareOn` true |
| A second independent client receives the real remote screen track | real-E2E | yes | same — `clientB.remoteParticipants[A].screenSharing` true |
| Authority alone does NOT imply an active share (local or remote) | real-E2E | yes | same |
| Stop → remote track ends, both sides reconcile inactive, A stays connected | real-E2E | yes | same |
| Presenter revoke withdraws authorization, no stale active-share | real-E2E | yes | same |
| Local vs remote screen-share state never conflated | unit + real-E2E | yes | `livekit_live_media_client_test` ("local/remote screen-share state separation") + the E2E |
| Presenter authority without publication; publication active vs inactive | unit + widget | yes | Sprints 9/10 groups (capability sync, publication reconciliation, panel) |
| Cancel / failure cleanup; revoke-while-sharing stops + hides | widget | yes | `live_media_panel_test` (Sprints 8/10) |
| Duplicate / out-of-order / stale remote + capability events | unit | yes | `livekit_live_media_client_test` (Sprints 9/11) |

**Secondary objective — remote reconnection (investigated, NOT E2E-verified).**
`livekit_client` 2.13.0 exposes room-level `RoomReconnecting`/`RoomReconnected`
events (mapped and unit-verified, path 6 of the matrix) but **no reliable
per-remote-participant reconnecting flag**, and a true transport partition cannot
be induced deterministically in a single-runner Docker harness without making the
test flaky. The deterministic contract that matters IS covered as unit tests:
reconnect does not duplicate a participant (reconcile-from-snapshot), a departed
participant is dropped and never revived by a stale event, the remote set is
cleared on connect/disconnect so a new session inherits no stale media, and a
local reconnect opens a fresh room without a duplicate. Per-participant reconnect
as a real E2E is **not claimed**; it stays an honest limitation.

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
