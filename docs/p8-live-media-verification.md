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
on a fake. One further, test-only correction is needed: `flutter test` reports
`defaultTargetPlatform` as `android` by default, which makes the SDK's guard
treat the browser as web-**mobile** and refuse screen share ("Screen sharing is
not supported on mobile devices"); a real DESKTOP web browser — the only platform
ADR 0030 ships — reports a desktop platform and is allowed, so the test overrides
`debugDefaultTargetPlatformOverride` to `TargetPlatform.linux` to match. This
changes no production behaviour, authorization or browser security, and the
capture is still a genuine getDisplayMedia track (asserted on its own). The
proven connect/audio harnesses are unchanged (still headless) so
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

## Sprint 14 — multi-participant lifecycle & session termination

Sprint 14 strengthens the VERIFICATION of the existing live-session lifecycle
under more than two participants and under moderator-initiated termination. The
audit found the lifecycle already correct and well unit-tested (the stale/
superseded-client guard, dispose→disconnect, reconcile-from-snapshot, and the
backend end contract are all in place and covered), so **no production code
changed** — the gaps were real-LiveKit coverage of three participants and of a
connected client observing session end.

**Three-client harness** (`app/test/e2e/livekit_three_client_e2e_test.dart`,
real-E2E). Extends the Sprint 12 two-client harness to A (owner) + B + C (two
STUDENTs provisioned the same authorization-preserving way — the fixture's
`provisionParticipant` reused verbatim). Asserted at the application boundary
(`remoteParticipants`), bounded event-driven waits:

| Behavior | Kind | Ran? | Evidence |
|---|---|---|---|
| Three independent clients, one real room, DISTINCT identities | real-E2E | yes | `livekit_three_client_e2e_test` (`_userB != _userC`; A sees exactly {B,C}) |
| Each client sees exactly the OTHER two; none sees itself; no duplicate | real-E2E | yes | same (length == 2 on A/B/C; B/C exclude their own id) |
| B's real mic reconciles to `live` on BOTH other clients | real-E2E | yes | same |
| One participant (C) leaving removes ONLY C; A and B remain, B's audio intact | real-E2E | yes | same (A/B length → 1, C absent, B still `live` on A) |
| Three-party reconcile: one departs → only that one removed, others' media intact | unit | yes | `livekit_live_media_client_test` ("three participants: one departs …") |

**Session termination** (`app/test/e2e/livekit_session_end_e2e_test.dart`,
real-E2E). The backend END contract (`POST /live/sessions/:id/end`, moderator-
gated: ends atomically, deletes the media room, refuses later joins) was already
unit/spec-tested on the backend and at the controller (roomDeleted→rejoin-or-
terminal). This adds the one missing end-to-end link — a CONNECTED client
observing termination over real LiveKit:

| Behavior | Kind | Ran? | Evidence |
|---|---|---|---|
| Owner connects, then ends the session (`HttpLiveRepository.endSession`) | real-E2E | yes | `livekit_session_end_e2e_test` (`ended.state == ended`) |
| The connected client observes the authoritative terminal transition | real-E2E | yes | same — media state reconciles to `LiveMediaDisconnected(roomDeleted)` via the real SDK event |
| A fresh join after termination is refused | real-E2E | yes | same — `LiveException(live.session_not_live)` |

This harness runs LAST in its own workflow step because it ends the shared
session; every other harness finishes with the session first. Attendance and
moderation records are untouched (attendance is a separate module; end stores
`ended` before deleting the room, preserving attendance's race-safety — not
modified here).

**Still NOT E2E-verified (honest, unchanged from Sprint 13).** Per-participant
RECONNECT: `livekit_client` 2.13.0 exposes room-level reconnecting/reconnected
(unit-verified) but no reliable per-remote reconnecting flag, and a true
transport partition cannot be induced deterministically in this harness. The
idempotency that matters (reconnect/rejoin never duplicates a participant, a
departed one is dropped and never revived, a new session inherits no stale
media) is unit-covered. Reconnect is **not** claimed as end-to-end verified.

## Sprint 15 — failure recovery & room-reset recovery

Sprint 15 audits the failure-recovery and resource-lifecycle paths. The adapter
port cleanup (best-effort, rethrows the FIRST error without masking; reconnect
never reuses an orphaned room) and the controller `_generation` stale-guard are
confirmed correct and observably tested. But a new real-LiveKit room-reset test
exposed **one genuine defect**, now fixed.

**DEFECT FIXED — stale media state survived a terminal drop
(`livekit_live_media_client.dart`).** The client reset its remote-participant set
and publication on an explicit `connect()` and `disconnect()`, but NOT on a
TERMINAL SDK-driven drop (`LiveKitDisconnected` — a room reset deleting the room,
a kick, a duplicate identity): `_onSignal` set the state but left `_remote`,
`_publication` and `_screenAllowed` stale until some later connect/disconnect
happened to reset them. So after a `roomDeleted`, the roster could still show a
participant (and a mic/screen chip) from a room that no longer existed —
violating the invariant that media state is valid only while connected. The
room-reset E2E reproduced it (`remoteParticipants[B]` was non-null right after
`roomDeleted`); a deterministic unit test reproduces it too. Fix: the terminal
`LiveKitDisconnected` case now clears the remote set, the publication and the
authorization — exactly as `disconnect()` does — while a transient
`LiveKitReconnecting` still PRESERVES state across the blip. Correct layer: the
client owns the media state; the invariant restored is "a terminal drop converges
to clean media state, no stale roster/publication outliving the connection."

| Scenario | Kind | Ran? | Evidence |
|---|---|---|---|
| A terminal drop clears the remote set, publication and authorization | unit | yes | `livekit_live_media_client_test` ("terminal disconnect clears media state (Sprint 15)") |
| A transient reconnecting PRESERVES the remote set and publication | unit | yes | same |
| (integration) `roomDeleted` on reset → the client no longer tracks the departed peer | real-E2E | yes | `livekit_session_reset_e2e_test` (the regression that exposed the defect) |

**Microphone publish failure (unit).** The screen path already proved a refused
publish surfaces a sanitized `media_error` without faking an "on"; the symmetric
microphone case was untested (the fake port had no mic-failure injection).
`livekit_live_media_client_test` now drives `failMicrophone`:

| Scenario | Kind | Ran? | Evidence |
|---|---|---|---|
| A refused mic publish surfaces `media_error`; publication stays off; no token leak | unit | yes | `livekit_live_media_client_test` ("a microphone publish failure surfaces media_error …") |

**Room-reset recovery (real-E2E).** The one RECONNECTION scenario this harness
can induce deterministically: a moderator resets the media room (a new room is
ensured, the old deleted, the session stays LIVE), a connected client observes
the real `roomDeleted` drop, and both clients RECOVER to the NEW room via a
fresh join with clean state. `app/test/e2e/livekit_session_reset_e2e_test.dart`:

| Behavior | Kind | Ran? | Evidence |
|---|---|---|---|
| A + B connect; A observes B | real-E2E | yes | `livekit_session_reset_e2e_test` |
| `resetRoom` deletes the old room; BOTH clients observe `roomDeleted` | real-E2E | yes | same (real SDK `RoomDisconnectedEvent roomDeleted`) |
| The old room's remote state is dropped (no ghost) | real-E2E | yes | same (A no longer tracks B) |
| Both RECOVER to the NEW room via a fresh join, CLEAN (connect resets state) | real-E2E | yes | same |
| A re-observes EXACTLY B (once, no duplicate, no stale); B re-observes A | real-E2E | yes | same |

This runs in its own headless workflow step (a reset drops every connected
client, so it is isolated); it does not end the session, so the session-end step
after it still fresh-joins the new room.

**Reconnect — explicitly NOT VERIFIED E2E (unchanged, honest).** The SDK's
INTERNAL network reconnect — `RoomReconnecting` → `RoomReconnected` on a
transient signal blip without losing the room — is mapped and UNIT-verified
(`livekit_room_port` / `live_media_controller`), but a genuine transient network
partition that keeps the room alive cannot be induced deterministically in a
single-runner Docker harness (restarting / pausing LiveKit loses the room, which
is `roomDeleted`, a different path). It is **not** claimed as end-to-end
verified. What IS verified end-to-end is the application-level RECOVERY after a
room-level drop (reset → roomDeleted → recover to the new room, above) and the
terminal end path (Sprint 14). The deterministic idempotency/stale-state
cleanup that matters (no duplicate on rejoin, departed dropped, connect/disconnect
reset the local + remote set) is unit-covered.

## Sprint 16 — reconnect contract & stale-signal ownership closure

Sprint 16 audits the reconnect/concurrency/cleanup contract and closes the last
stale-state ownership gap. Findings grounded in the pinned `livekit_client`
2.13.0 adapter (`livekit_room_port.dart`): `RoomReconnectingEvent` →
`LiveKitReconnecting`, `RoomReconnectedEvent` → `LiveKitConnected` (reconnected is
NOT a terminal drop — it returns to connected), `RoomDisconnectedEvent` →
`LiveKitDisconnected(reason)` (a `clientInitiated` leave is dropped, never mapped
to a kick). The adapter reconciles the remote/local/capability snapshot on each
room event; the controller `_generation`/`_isCurrent` stale-guard and the
adapter's best-effort teardown were re-confirmed correct and observably tested —
unchanged.

**DEFECT FIXED — a stale reconcile signal could resurrect media state after a
drop (`livekit_live_media_client.dart`).** The port's signal stream is an ASYNC
broadcast and the client's subscription outlives `disconnect()` (only `dispose()`
cancels it), so a reconcile signal (capability / local tracks / remote
participants) queued around a teardown could be delivered AFTER a terminal drop
or an explicit leave. `_onSignal` applied those signals unconditionally, so a
late event could re-populate the roster / publication / screen authorization
while the client was idle/disconnected — a stale indicator with no live
connection behind it. Sprint 15 cleared state AT the terminal transition; this
closes the matching window AFTER it. Fix (client, the owning layer): the three
reconcile cases now apply only while `_hasLiveConnection`
(`connected` || `reconnecting`); a signal in any non-live state is ignored. A
transient `reconnecting` is deliberately still live, so the client keeps
converging across the blip.

| Scenario | Kind | Ran? | Evidence |
|---|---|---|---|
| A remote signal after an explicit disconnect is ignored | unit | yes | `livekit_live_media_client_test` ("stale reconcile signals without a live connection …") |
| A local-tracks signal after disconnect does not resurrect the publication | unit | yes | same |
| A capability signal after disconnect does not re-authorize screen share | unit | yes | same |
| A late remote signal queued around a terminal drop cannot bring a peer back | unit | yes | same |
| A reconcile signal DURING reconnecting IS applied (converges across a blip) | unit | yes | same |

**Concurrency / ownership re-confirmed (no change).** Superseded connect (the
controller `_generation` guard: "a join that resolves after disconnect does NOT
reconnect"), one-room-at-a-time teardown (the adapter: "connect tears down a
still-open previous room", "reconnecting never reuses the orphaned room"), and
disposal cleanup (the observable `_FakeLiveRoom`) are already covered. No new
guard or state store was added — the existing mechanisms provide the ownership
guarantees.

**Diagnostics re-confirmed adequate (no change).** Media failures surface as a
sanitized `LiveMediaException(media_error)` carrying only the error's runtime
TYPE — never a token, URL or body (tested: "a failure never leaks the token into
the exception"); the E2E diagnostics redact JWTs and token/secret values. The
meaningful categories the app acts on are already distinct codes
(`invalid_grant`, `screen_not_permitted`, `not_connected`, `media_error`) plus the
typed `LiveMediaDisconnectReason` (roomDeleted / participantRemoved /
duplicateIdentity / other). Left unchanged.

**Reconnect — still NOT VERIFIED E2E (unchanged, honest).** The SDK's INTERNAL
network reconnect (`RoomReconnecting` → `RoomReconnected` on a transient blip that
keeps the room) is mapped and now UNIT-verified on both the terminal-clear and
the reconnecting-preserve/converge sides, but a genuine partition that preserves
the room cannot be induced deterministically in a single-runner Docker harness
(restarting / pausing LiveKit loses the room → `roomDeleted`, a different path —
the documented blocker). What IS verified end-to-end remains: room-reset recovery
(Sprint 15), terminal end (Sprint 14), multi-participant and screen-share
(Sprints 12–14). Internal reconnect is not claimed as end-to-end verified.

## Sprint 17 — production-readiness: capability matrix, ownership, repeated sessions

Sprint 17 consolidates the evidence for production use. The audit found no new
production defect (Sprints 15–16 closed the stale-state gaps; the concurrency
guards, teardown and diagnostics are correct and tested), so the deliverables are
a repeated-session lifecycle test that was genuinely missing, and the two records
below that previously did not exist as a single source.

### Browser / platform capability matrix (evidence-based)

Targeted platform contract (ADR 0030): **web-first, Chrome desktop**, microphone
+ screen share only. Status codes: VERIFIED AUTOMATED / VERIFIED MANUAL / UNIT
ONLY / NOT VERIFIED / UNSUPPORTED BY CONTRACT.

| Capability (web) | Status | Evidence |
|---|---|---|
| Chrome desktop — mic publish / mute / unmute | VERIFIED AUTOMATED | `livekit_web_e2e_test` + two/three-client E2E (real LiveKit; the audio INPUT is a fake device, but connect/publish/subscribe/mute are real) |
| Chrome desktop — screen capture → publish → remote reception → stop | VERIFIED AUTOMATED | `livekit_two_client_screenshare_e2e_test` (headed Chrome on Xvfb, `--auto-select-desktop-capture-source`; genuine capture, not a fake device) |
| Chrome desktop — remote presence / audio / screen reconciliation (2 & 3 clients) | VERIFIED AUTOMATED | `livekit_two_client_e2e_test`, `livekit_three_client_e2e_test` |
| Chrome desktop — room-reset recovery & session-end terminal drop | VERIFIED AUTOMATED | `livekit_session_reset_e2e_test`, `livekit_session_end_e2e_test` |
| Mic permission DENIAL / missing device | UNIT ONLY + VERIFIED MANUAL | widget "denied → recoverable, stays off"; `livekit_live_media_client_test` mic-publish-failure; manual B2. CI auto-accepts (`--use-fake-ui-for-media-stream`), so denial is NOT exercised automated. |
| Interactive screen PICKER (choose window / cancel) | VERIFIED MANUAL | manual B1. The automated E2E deliberately bypasses the picker via auto-select; the picker/cancel path has NO automated coverage. |
| Transient SDK INTERNAL reconnect (`Reconnecting`→`Reconnected`, same room) | UNIT ONLY | mapping + reconnecting-preserve/converge + stale-signal guard are unit-tested; **NOT VERIFIED E2E** (see below). |
| Other desktop browsers (Firefox / Safari / Edge) | NOT VERIFIED | CI runs Chrome only; ADR 0030 is Chrome-first and makes no contract claim beyond Chrome. |
| Mobile web browsers (Android / iOS web) | UNSUPPORTED BY CONTRACT | ADR 0030 (native mobile is a separate future phase); the SDK refuses screen share on web-mobile (`lkPlatformIsWebMobile`). |
| Camera / remote video | UNSUPPORTED BY CONTRACT | ADR 0030 — explicitly out of scope. |

"Compilation succeeds" is NOT treated as support for any row above.

### Resource ownership & cleanup (single table)

| Resource | Owner | Created | Normal release | Failure cleanup | Observable test |
|---|---|---|---|---|---|
| LiveKit `Room` | `SdkLiveKitRoomPort` (`_openSdkRoom`) | `connect()` | `_teardownRoom` on disconnect / replace / dispose (cleared FIRST) | half-open room released on connect failure; the connect error (not a teardown error) propagates | `livekit_room_port_test` (teardown order; connect-failure leaves no room) |
| Room `EventsListener` | `_SdkLiveRoom` | `_openSdkRoom` | `disposeListener` in `_teardownResources` | attempted even if a later step throws; FIRST error rethrown (never masked) | `livekit_room_port_test` (throwing-listener-disposal; dispose rethrows after close) |
| Local mic / screen tracks | SDK (`room.localParticipant`) | `set{Microphone,ScreenShare}Enabled` | SDK releases on room disconnect / stop; app reflects via `LiveKitLocalTracks` | — | publication-reconciliation unit tests; screenshare E2E stop |
| Remote track subscriptions | SDK | `TrackSubscribed` | SDK releases on unsubscribe / disconnect; app reflects via reconcile-from-snapshot | — | remote-reconciliation unit tests; 3-client E2E departure |
| Port signal `StreamController` | `SdkLiveKitRoomPort` | construction | closed in `dispose()` (even if teardown throws) | — | `livekit_room_port_test` ("dispose closes the signal controller even when teardown throws") |
| Client state / publication / remote streams | `LiveKitLiveMediaClient` | construction | closed in `dispose()` | reset on connect + disconnect + terminal drop (S15); late signals ignored off-connection (S16) | client tests (terminal-clear, stale-signal guard, repeated-session S17) |
| Client signal subscription | `LiveKitLiveMediaClient` | construction | cancelled in `dispose()` (NOT `disconnect()`) | — | client "dispose releases the port and the subscription" |
| `LiveMediaController` + its client-state subscription | Riverpod `autoDispose.family` by sessionId | `build()` | `onDispose`: `_generation++`, cancel subscription, `disconnect()` the client | `_isCurrent` stale-guard ignores a late connect/rejoin result | controller tests (dispose disconnects; stale join; roomDeleted rejoin) |
| Pending connect / rejoin futures | `LiveMediaController` | `connect()` / `_rejoinIfLive` | generation-guarded; single-flight `_rejoining` | `_isCurrent(gen)` drops a stale result | controller tests (stale-join; duplicate-connect ignored) |

**Session-isolation invariant.** The production client is a singleton with ONE
`SdkLiveKitRoomPort` owning ONE room at a time (`connect()` tears the previous
room down first), and each session has its OWN `autoDispose.family` controller.
So there is no concurrent "newer session's room" that an older controller could
accidentally dispose — the single port serializes rooms, and a disposed
controller only disconnects the one shared client it was watching. Concurrent
independent media sessions are NOT a supported configuration.

### Repeated-session lifecycle (new coverage)

No looped multi-cycle test existed (prior coverage was single session-change).
`livekit_live_media_client_test` now runs 5 cycles of connect → (mic on, remote
appears) → disconnect, asserting each cycle starts CLEAN (no remote/publication
from the prior cycle; authority re-seeded from the new grant) and ends clean —
and that leaving while a mic publish is in flight does not resurrect it.

### Diagnostics (re-confirmed adequate, unchanged)

Media failures surface as one of four `LiveMediaException` codes — `invalid_grant`,
`screen_not_permitted`, `not_connected`, `media_error` — plus the typed
`LiveMediaDisconnectReason` (roomDeleted / participantRemoved / duplicateIdentity
/ other). `media_error` carries only the error's runtime TYPE, never a token, URL
or body; three unit tests assert no token/secret leaks. Left unchanged.

### Transient reconnect — investigated, remains NOT VERIFIED E2E

The one capability still unverified end-to-end. Findings this sprint: the SDK's
reconnect window is generous (`defaultRetryDelaysInMs` ≈ 50 s before giving up),
and `docker compose pause livekit` (SIGSTOP) would freeze the server while
PRESERVING the room — unlike restart/stop, which delete it (`roomDeleted`, a
different path). A pause of ~20 s is, in principle, within the give-up window and
long enough for ICE/ping loss detection, so a genuine `Reconnecting`→`Reconnected`
of the SAME room is feasible in principle. The blocker to adding it as a gate:
the trigger timing depends on SDK-internal ICE/ping thresholds that cannot be
validated in this sandbox (no local Chrome), so an unvalidated timing-dependent
test risks flakiness, which is worse than an honest gap. What would close it: a
validated pause-timing run (ideally first in a dedicated, non-blocking diagnostic
job) confirming the `Reconnecting`→`Reconnected` lifecycle on the same room. The
deterministic contract — reconnecting preserves/converges state, a terminal drop
clears it, late signals are ignored off-connection — IS unit-verified.

## Sprint 18 — reconnect diagnostic & remaining race closure

Sprint 18 builds a genuine transient-reconnect experiment and fills the last two
untested race orderings. No new production defect was found; the production code
is unchanged (the Sprints 15–16 guards cover these orderings — this adds the
missing deterministic tests and a real reconnect diagnostic).

### Transient reconnect — real experiment (dedicated, non-blocking diagnostic)

A new browser E2E (`app/test/e2e/livekit_reconnect_e2e_test.dart`) and a SEPARATE
dispatch-only workflow (`.github/workflows/live-reconnect-diagnostic.yml`) induce
a GENUINE transient interruption of the SAME room: two real clients join, then
the LiveKit container is FROZEN with `docker compose pause livekit` (SIGSTOP
preserves the room in memory — unlike restart/stop, which delete it →
`roomDeleted`, a different path) for ~25 s, then resumed. The test observes the
REAL `RoomReconnecting` → `RoomReconnected` lifecycle through the production
adapter and FAILS loudly if reconnecting is never entered or recovery never
occurs — it never falls back to a fake. The workflow is kept OUT of the
regression pipeline (`live-e2e.yml`) on purpose: its timing sensitivity must
never make the normal CI flaky. Timing rationale: the freeze is long enough for
the SDK to detect loss (ICE/ping) and well within its ~50 s give-up window
(`defaultRetryDelaysInMs`), so the SAME room recovers.

**Result of this sprint's dispatched run (real evidence).** The diagnostic
genuinely induced a transient reconnect and advanced the long-standing gap:

- **VERIFIED E2E:** a `docker compose pause livekit` (room preserved) made the
  real SDK enter the reconnecting lifecycle — the run logged
  `RoomReconnectingEvent()` on BOTH clients and `SignalReconnectedEvent()` (the
  signal transport reconnected). This is a GENUINE transient interruption of the
  SAME room, NOT a terminal `roomDeleted` drop. Prior sprints could not even
  induce this; it is now proven real. The adapter surfaced it as
  `LiveMediaReconnecting` (state preserved across the blip, per the contract).
- **NOT VERIFIED E2E:** full room recovery — `RoomReconnectedEvent` →
  `LiveMediaConnected` — did NOT complete within the window. The signal
  reconnected but the media/ICE (peer-connection) path did not fully re-establish
  in this HEADLESS, no-TURN CI harness, so the client did not return to connected.
  The test records `fullRoomRecovery=false` and does not fake a recovery that did
  not occur.

So the test asserts only the reliably-real facts (interruption + reconnecting
entry, no terminal drop) and RECORDS the recovery outcome; it is a GREEN, honest,
non-flaky diagnostic of what is genuinely verified. The remaining blocker for
full-recovery verification is the media/ICE re-establishment after a freeze in a
headless, TURN-less browser — not the room lifecycle (the room was preserved and
reconnecting was entered). Closing it would need a harness with working media
reconnection (e.g. a TURN relay or a headed browser with a stable media path).
A green regression pipeline does NOT by itself prove transient reconnection; this
row is the authoritative status.

### New race coverage (deterministic unit — fills real gaps)

| Scenario | Kind | Ran? | Evidence |
|---|---|---|---|
| A revoke while a screen publish is STARTING leaves it not-active (no false-active from the late start) | unit | yes | `livekit_live_media_client_test` ("publish-vs-revoke and terminal-while-reconnecting races (Sprint 18)") |
| A TERMINAL drop WHILE reconnecting clears state and goes disconnected (not stuck reconnecting) | unit | yes | same |

These complement the already-covered orderings (session replacement / stale
connect via the controller `_generation` guard; late signals after a drop via the
Sprint 16 guard; leave-while-mic-pending + repeated sessions via Sprint 17);
those were NOT duplicated.

### Phases 4–5 re-confirmed (no change)

The Sprint 17 capability matrix, the per-resource ownership table, the
session-isolation invariant (one singleton port → one room at a time; concurrent
independent sessions unsupported) and the sanitized diagnostic contract (four
`LiveMediaException` codes + typed `LiveMediaDisconnectReason`, no token leak)
remain accurate; no production change. The one capability matrix row that changes
is transient internal reconnect, per the diagnostic run above.

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
