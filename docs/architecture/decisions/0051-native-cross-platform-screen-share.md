# 0051 — Native cross-platform live screen share (Android + iOS)

**Status:** Accepted
**Date:** 2026-10-26

## Context

Live **audio** already works on every target the app ships: the web since
[0030](0030-flutter-livekit-media-client.md), and native iOS/Android behind the
`LIVE_MEDIA_NATIVE_ENABLED` opt-in. Live **screen share**, however, was web-only:
`screen_capture_support.dart` hard-returned `false` off the web and its docstring
said "native media is audio only; screen sharing stays a web capability". The
product requires the teacher to share the Android/iOS device screen to
participants from inside the real mobile app, with students receiving it — not
only on the web.

The investigation (read-only, against the pinned SDKs) established:

- The publish and receive paths already exist and are **platform-agnostic**. The
  LiveKit adapter (`livekit_room_port.dart`) calls
  `localParticipant.setScreenShareEnabled(...)` and renders a remote screen via
  `VideoTrackRenderer` (native `RTCVideoView`), and the backend join token
  already grants a presenter `canPublishSources: [SCREEN_SHARE]` and students
  `canSubscribe` — server-decided, platform-neutral. **No backend or
  LiveKit-server change is needed.**
- The real gap is **platform plumbing the SDKs do not provide**:
  - **Android:** `flutter_webrtc` 1.6.2+hotfix.3 ships no foreground service and
    declares no foreground-service permissions (its Android manifest is empty).
    But Android 10+ (strictly enforced on 14+) refuses
    `MediaProjection.getMediaProjection()` unless a foreground service of type
    `mediaProjection` is already running. So the **app** must own that service.
  - **iOS:** screen capture is only possible from a separate **ReplayKit
    broadcast upload extension** that feeds frames to the host app through an
    **App Group**; the host publishes them when the room uses
    `ScreenShareCaptureOptions(useiOSBroadcastExtension: true)`. That extension
    target, its entitlements/App Group, the host Info.plist keys and the broadcast
    picker can only be produced and signed with Xcode, and validated on a device.
- `Hardware.instance.requestCapturePermission()` is the only public SDK API for
  the Android MediaProjection consent (marked `@experimental`); it is a no-op
  returning `true` off Android/macOS. The iOS `BroadcastManager` is **not** in the
  pinned SDK's public API.

## Decision

Implement native screen share **client-side only**, keeping the existing seams
and authorization, with no temporary hacks:

1. **Screen share is a separate capability from native audio**, behind its own
   opt-in `LIVE_MEDIA_NATIVE_SCREEN_SHARE_ENABLED` (meaningful only with
   `LIVE_MEDIA_NATIVE_ENABLED`; the provider ANDs them). The web is unaffected and
   keeps feature-detecting `getDisplayMedia`.

2. **`screenCaptureSupported` becomes a platform-aware capability**
   (`{platform, nativeScreenShareEnabled}`): web feature-detects (unchanged),
   native is iOS/Android when opted in, desktop never. It drives the UI gate only.

3. **A `ScreenCaptureController` seam** (plain Dart, no SDK, no platform channel)
   expresses "prepare the device, then release it" around the SDK publish. The
   LiveKit client composes it: prepare before capture (a declined consent is a
   no-op, never an error), and release on **every** stop path — explicit stop, a
   server revoke, a disconnect, a terminal drop, and the OS/user ending capture
   (the reconciled published→unpublished transition). The default is a no-op
   (web, unsupported targets, every unit test), so audio and web behaviour are
   unchanged.

4. **Android:** `AndroidScreenCaptureController` obtains consent via
   `Hardware.instance.requestCapturePermission()` and starts/stops a bespoke
   `mediaProjection` foreground service (`ScreenCaptureService.kt`, a persistent
   notification) over a method channel wired in `MainActivity.kt`. Manifest gains
   `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION` and the `<service
   foregroundServiceType="mediaProjection">`.

5. **iOS:** `IosScreenCaptureController` + room option `useiOSBroadcastExtension`
   on iOS. The broadcast extension, App Group, entitlements, host Info.plist keys
   and the native broadcast-picker handler are authored as scaffolding
   (`ios/BroadcastExtension/`, `ios/Runner/ScreenBroadcastChannelHandler.swift`)
   but require Xcode to build/sign and a real device to validate. iOS screen
   share is **NOT** considered complete until those real-device checks pass.

6. **No new pub dependency.** Android consent reuses `livekit_client`'s
   `Hardware`; the foreground service is the app's own ~120-line Kotlin rather
   than the `flutter_background` package, so nothing new enters the dependency
   graph and the boundary (`livekit_client` only inside `lib/data/media/livekit/`,
   [0030]) is preserved.

7. **Screen-share audio stays disabled** per [Q56] — unchanged on every platform.

## Consequences

- Android screen share is implementable and APK-buildable on the current
  toolchain; the real teacher→student capture path is confirmable only by a
  two-device test (the automated tests prove the orchestration, not real capture).
- iOS needs a Mac/Xcode and a device; until then its controller fails safe
  (the share control surfaces an error, never a pretended success).
- The capability split means a build can enable native audio without screen
  share, and the UI tells an unsupported presenter plainly instead of offering a
  share that would fail.
- `screen_capture_support.dart`'s signature changed and the two pinning tests
  (`live_media_activation_test.dart`, `live_media_panel_test.dart`) plus new unit
  tests (`screen_capture_support_test.dart`, the ADR-0051 group in
  `livekit_live_media_client_test.dart`) cover the capability and the lifecycle.

Supersedes the "screen sharing stays a web capability" stance recorded in
[0030]'s media docstrings; [0030]'s SDK-confinement boundary is unchanged.

[Q56]: ../../live.md
