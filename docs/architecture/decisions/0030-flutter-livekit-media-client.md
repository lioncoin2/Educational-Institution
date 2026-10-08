# 0030 — Flutter LiveKit media client (P7b)

**Status:** Accepted
**Date:** 2026-10-07

## Context

The backend's live media is LiveKit and has been since [0003](0003-rtc-provider-abstraction.md):
the domain works behind an `RtcProvider` port, one adapter signs tokens against
LiveKit, and the deployment runs the pinned **LiveKit server 1.13.7** with
**`livekit-server-sdk` 2.19.1** (`backend/src/platform/config/livekit-config.ts`,
`backend/package.json`). `POST /live/sessions/:id/join` is the sole credential
path: it issues a short-lived token scoped to `roomJoin` for one named room
(the room name carries the media-room epoch), with the caller's capabilities
decided server-side (`live.md` §9, §16; the P12 media discovery). The token
bounds only the first connection; the media server refreshes it thereafter, and
`/join` is the way back in.

The Flutter app built the media foundation **without any SDK**, provider-neutral
and bound to an Unavailable default:

- **Slice A** (`ca7a0e4`) — the contracts: `LiveMediaGrant` (the join ticket,
  token redacted in `toString`), the `LiveMediaState` machine, the app-owned
  `LiveMediaDisconnectReason`, the `LiveMediaClient` seam
  (`connect`/`disconnect`/`setMicrophoneEnabled`/`setScreenShareEnabled`/`state`/
  `states`), and `UnavailableLiveMediaClient`; plus `LiveRepository.join`.
- **Slice B** (`443d3b4`) — `LiveMediaController`: session-scoped media transport
  orchestration (explicit connect, stale-result guard, terminal-reason handling),
  tested entirely against a `FakeLiveMediaClient`.

Neither carries live audio: the seam is bound to `UnavailableLiveMediaClient` in
every build, and `docs/architecture/live.md` §17 always named a future
`livekit_client` adapter (P7b) as the only SDK importer. The app ships **web**
(GitHub Pages, `deploy-pages.yml`); the `android/` and `ios/` projects exist but
are vanilla and are never built by CI, and there is no Codemagic.

A version-lock gate verified, against pub.dev on this date, the one remaining
unknown — which concrete client realizes the seam and whether it fits this
toolchain. `livekit_client` **2.13.0** is the current stable; its `environment`
is Dart `>=3.10.0 <4.0.0` and Flutter `>=3.38.0` (both satisfied by this
project's Dart `^3.13.4` and Flutter `3.47.5`); it pins **`flutter_webrtc`
1.6.2+hotfix.3** (Android `minSdkVersion ≥ 23`, Java 8; iOS ≥ 12.1; web +
desktop); its `DisconnectReason` exposes `duplicateIdentity`, `roomDeleted`,
`roomClosed`, `participantRemoved` and `clientInitiated`; and `LocalParticipant`
exposes `setMicrophoneEnabled(bool)` and `setScreenShareEnabled(bool)`. This ADR
records the resulting decision; it changes no code, dependency or native
project.

## Decision

Adopt **`livekit_client` 2.13.0** (which pins **`flutter_webrtc`
1.6.2+hotfix.3`**) as the Flutter media provider, realized by a single adapter
`LiveKitLiveMediaClient` that implements the existing `LiveMediaClient`. The
backend stays on LiveKit server 1.13.7 / `livekit-server-sdk` 2.19.1. This is the
Flutter counterpart of [0003](0003-rtc-provider-abstraction.md), not a competing
provider: backend "LiveKit provider" and Flutter "LiveKit client adapter" are
one technology on two sides of `/join`.

### Architecture

```
UI
 ↓
LiveMediaController            (Slice B — media transport orchestration)
 ↓
LiveMediaClient               (Slice A — the provider-neutral seam)
 ↓
LiveKitLiveMediaClient        (P7b — the ONLY livekit_client importer)
 ↓
livekit_client → flutter_webrtc → Web / Android / iOS media platform

— and, separately —

LiveSessionController → LiveSession     (session authority, HTTP + realtime)
```

These are **two separate state machines**. Session authority (is a session
live, who may do what) is `LiveSessionController`/`LiveSession`; media transport
(is this device carrying the audio) is `LiveMediaController`/`LiveMediaState`.
Neither owns the other, and a media fact is never written back as session state.

### Boundary

Only `LiveKitLiveMediaClient` may import `livekit_client` or `flutter_webrtc`.
Neither may be imported by `LiveMediaController`, `LiveSessionController`, the UI,
the repository, the models, or any application/domain code. The adapter owns the
LiveKit `Room`, its events and connection state, provider-specific disconnect
reasons, local track operations, the connected-session token refresh, and
provider-error translation — and exposes only `LiveMediaClient`/`LiveMediaState`
upward. The `live.md` §17 guard (no `livekit_client`/`flutter_webrtc`/
`dart_webrtc` in `pubspec` or `lib/`) is narrowed, when the adapter lands, to
allow those imports in that one file only.

### Contracts (Slice A/B) — unchanged

No contract change is required. The version gate confirmed each against the
2.13.0 API:

- `LiveMediaGrant` — **KEEP**; `url` + `token` are exactly `Room.connect`
  inputs; `media.*` are grant hints.
- `LiveMediaState` — **KEEP**; covers LiveKit's connection states.
- `LiveMediaDisconnectReason` — **KEEP**; the mapping below is verified.
- `LiveMediaClient` — **KEEP**; `setMicrophoneEnabled`/`setScreenShareEnabled`
  match the SDK verbatim.
- `LiveMediaController` — **KEEP**; its lifecycle/terminal-reason/stale-guard
  logic is provider-agnostic.

A future participant **roster / speaking** stream is an **additive** extension
to the seam (and a new plain-Dart participant model); it is **not** part of this
ADR's initial provider contract and requires no change to what exists.

### Token security

`/join` is the authoritative credential path. The client receives a scoped
`roomJoin` token for one room, passes the ephemeral `LiveMediaGrant` straight to
the adapter's `connect`, and drops the reference. The token is **never**
persisted, logged, placed in analytics, put in a navigation argument, or exposed
in UI state; `LiveMediaGrant.toString()` already redacts it, and the adapter must
never log a raw JWT (scrubbing any SDK error it wraps). The LiveKit server
refreshes the connected session's token internally — the app never sees a
refreshed token and needs no refresh callback; `/join` is used only for entry
and re-entry. The backend remains the sole authority for permissions.

### Reconnect

The SDK owns **transient** recovery — temporary network loss, signaling
reconnect, ICE restart, token refresh — surfacing `reconnecting`/`reconnected`.
`LiveMediaController` owns only **terminal** recovery: `duplicateIdentity` →
terminal (no rejoin); `participantRemoved` → terminal (explicit rejoin allowed);
`roomDeleted` → one session-liveness read, then a fresh `/join` if still live;
any other terminal failure → terminal per the Slice-B policy. **No second retry
engine is built around LiveKit.**

### Disconnect-reason mapping (verified)

| LiveKit `DisconnectReason` | `LiveMediaDisconnectReason` |
| --- | --- |
| `duplicateIdentity` | `duplicateIdentity` |
| `roomDeleted`, `roomClosed` | `roomDeleted` |
| `participantRemoved` | `participantRemoved` |
| every other terminal reason | `other` |

`clientInitiated` is an internal explicit-disconnect condition, never a
user-facing terminal reason.

### Room reset / session end

A **room reset** bumps the media-room epoch and deletes the old room; the old
credential cannot be reused. The client receives room deletion (`roomDeleted`/
`roomClosed`); the controller reads session authority (`LiveRepository.getSession`)
once — still live → fresh `/join` to the new room; ended/gone → stay
disconnected. A **session end** also deletes the room, so the media plane
**cannot itself distinguish** end from reset — session authority makes that
call. The media provider never duplicates session authority.

### Kick

Backend kick removes the participant via `RoomService.RemoveParticipant`; LiveKit
delivers `participantRemoved` to the affected client → `LiveMediaDisconnectReason.
participantRemoved`. No automatic rejoin; an explicit future `/join` remains
possible (the backend allows re-entry). The presenter grant is **not** revoked
by a kick, and there is no permanent client-side ban.

### Microphone

`LocalParticipant.setMicrophoneEnabled(bool)` is the provider operation behind
`LiveMediaClient.setMicrophoneEnabled`. The backend token capability is the
ceiling; the app does not recreate backend authorization. Publication is
media-plane behaviour, and "microphone enabled" is distinct from "currently
speaking".

### Screen share

`LocalParticipant.setScreenShareEnabled(bool)` is the provider operation behind
`LiveMediaClient.setScreenShareEnabled`. Authority (`presenterUserIds`,
`me.canPresent`, `me.presenting`) is the session's; the actual screen-share track
is media transport's; the two are never conflated. The backend currently sets
`screenAudio = false`, so the initial implementation does not depend on screen
audio.

### Platform strategy

- **Web — web-first.** It is the only shipped platform; GitHub Pages already
  builds web; `livekit_client` uses browser WebRTC; no native project change is
  required.
- **Android — supported, future native work:** `minSdk ≥ 23` (flutter_webrtc),
  `RECORD_AUDIO`, a microphone foreground service, MediaProjection + its
  foreground service for screen share (API 34/35 foreground-service typing), and
  physical-device verification.
- **iOS — supported, future native work:** microphone usage description,
  `AVAudioSession`, optional background-audio policy, a ReplayKit Broadcast
  Upload Extension + App Group + entitlements for screen share, and
  physical-device verification.

Native work is a **separate implementation phase**. Media availability stays
platform-aware through the seam's `isAvailable`.

### Web limitations

Chromium is the primary supported web media target. Safari has platform
limitations around screen capture and screen audio; screen audio is disabled by
the backend regardless. The ADR does not promise identical behaviour across
browsers — gating per platform is expected.

### CI / release

CI is GitHub Actions: it analyzes and tests the Flutter app and builds/deploys
**web only**; the backend job runs the real-LiveKit-1.13.7 contract suite. There
is no Codemagic and no Android/iOS release pipeline. A web-first provider
implementation therefore needs **no** mobile pipeline; a native media rollout
requires a future mobile build/signing pipeline (a new GitHub Actions matrix or
Codemagic), which does not exist yet.

## Consequences

**Good.**
- One media technology end to end; the application stays provider-neutral and
  `LiveMediaController` stays testable against the fake.
- A web-first launch is possible immediately, with no native project changes.
- Native support can be added later without rewriting the media lifecycle —
  only the adapter and the native projects change.
- LiveKit's reconnect and token-refresh complexity stays inside the adapter.
- A clear security boundary: the client holds only a scoped `roomJoin` credential
  and cannot create, delete or list rooms, issue tokens, or change permissions.

**Bad, and accepted.**
- A dependency on LiveKit and on the native `flutter_webrtc`; SDK/server
  compatibility must be managed on upgrades (mitigated by the pinned server and
  its contract suite, and an exact client pin).
- Real native complexity for Android (MediaProjection, foreground services) and
  iOS (ReplayKit Broadcast Upload Extension, App Group, signing).
- Browser-specific media behaviour that the web build must gate around.
- The native path is unverifiable from CI today and needs a new mobile pipeline
  and device evidence.

## Risks

SDK upgrade drift; LiveKit server/client compatibility; the `flutter_webrtc`
native dependency; Android MediaProjection and foreground-service typing; iOS
ReplayKit, signing and App Group; browser screen-sharing gaps; token handling;
reconnect behaviour; the absent mobile CI; and device verification. Each is
carried into the relevant future slice; none reopens this decision.

## Conditions (implementation gates)

The version gate approved the choice **with conditions**. These gate the
implementation, not the architecture:

1. `flutter pub get` must resolve the full dependency graph on Flutter 3.47.5 /
   Dart 3.13.x.
2. The web release build must succeed.
3. A real end-to-end connection against LiveKit server 1.13.7 must be verified.
4. Native media requires separate physical-device evidence.
5. Android `minSdk` must satisfy `flutter_webrtc` (`≥ 23`).
6. Native requirements are implemented only in the later native slices.

## Open decisions

Genuinely unresolved (and only these):

- The final backoff/jitter policy for a terminal reconnect (Slice B does one
  immediate, event-driven re-join and no timers).
- Whether controller dispose should also disconnect the media client
  (background-audio vs leaked connection).
- The mobile CI provider (GitHub Actions matrix vs Codemagic).
- The exact per-platform / per-browser availability matrix.
- The future participant-roster/speaking contract.

The LiveKit provider choice, the `livekit_client` version, the media
architecture, and the Slice A/B contracts are **decided** and are not reopened
here.

## Alternatives considered

**Raw WebRTC (`flutter_webrtc` directly, no LiveKit client).** Rejected: the
backend is already a LiveKit SFU, so the client would have to reimplement
LiveKit's signaling and SFU coordination, bypassing the provider architecture
for no benefit.

**Another hosted SFU (Agora, Twilio, Daily, …).** Rejected: it would require
replacing the backend provider decided in [0003](0003-rtc-provider-abstraction.md)
and re-doing the server-side token, reconciler and contract suite. The provider
question is settled on the server.

**Platform-specific media implementations (separate web/Android/iOS clients).**
Rejected: it duplicates the transport, loses the unified `livekit_client` API
across platforms, and breaks the single-seam architecture Slices A/B established.

**Importing `livekit_client` throughout the app** (controllers/UI). Rejected: it
couples the whole app to the vendor, makes a future provider swap a rewrite, and
violates the boundary in [0003](0003-rtc-provider-abstraction.md) and `live.md`
§17. The adapter is the one allowed importer.

## References

- [0003](0003-rtc-provider-abstraction.md) — the backend RTC provider port
  (LiveKit).
- `docs/architecture/live.md` §9 (LiveKit hardening), §16 (what travels where),
  §17 (the Flutter `LiveRepository`/`LiveMediaClient` seam and the P7b plan).
- Flutter media Slices A (`ca7a0e4`) and B (`443d3b4`).
- The P7b media architecture discovery and the `livekit_client` version-lock gate
  (both recorded in session history; versions verified against pub.dev on
  2026-10-07).
