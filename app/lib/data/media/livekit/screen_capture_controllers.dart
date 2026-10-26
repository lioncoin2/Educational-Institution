import 'package:flutter/foundation.dart' show TargetPlatform, visibleForTesting;
import 'package:flutter/services.dart';
import 'package:livekit_client/livekit_client.dart' show Hardware;

import '../screen_capture.dart';

/// Platform screen-capture controllers for the LiveKit client (ADR 0051).
///
/// These are the single units that touch the platform for screen SHARE: the
/// Android MediaProjection consent + `mediaProjection` foreground service, and
/// the iOS ReplayKit system broadcast. They live inside the LiveKit adapter
/// directory because the Android consent step is LiveKit's
/// `Hardware().requestCapturePermission()` and the iOS step is its
/// `BroadcastManager` — `package:livekit_client` may be imported nowhere else
/// (ADR 0030, enforced by `test/live/live_boundaries_test.dart`). Everything
/// above the client composes only the plain [ScreenCaptureController] seam.

/// Method channel to the app's native Android foreground-service plumbing
/// (`android/.../ScreenCaptureService.kt`, wired in `MainActivity.kt`). Only the
/// Android controller uses it.
@visibleForTesting
const MethodChannel screenCaptureChannel = MethodChannel(
  'com.quraninstitution.quran_institution_app/screen_capture',
);

/// Chooses the capture controller for the running platform.
///
/// Pure selection so it is unit-tested without a device:
/// - the web needs no controller — the browser's `getDisplayMedia` prompt is the
///   consent step ([NoopScreenCaptureController]);
/// - without the native opt-in ([nativeScreenShareEnabled]) nothing native
///   captures, so Noop;
/// - Android and iOS get their real controllers; every other native target
///   (desktop) stays Noop.
ScreenCaptureController screenCaptureControllerFor({
  required bool isWeb,
  required TargetPlatform platform,
  required bool nativeScreenShareEnabled,
}) {
  if (isWeb || !nativeScreenShareEnabled) {
    return const NoopScreenCaptureController();
  }
  return switch (platform) {
    TargetPlatform.android => const AndroidScreenCaptureController(),
    TargetPlatform.iOS => const IosScreenCaptureController(),
    _ => const NoopScreenCaptureController(),
  };
}

/// Android screen capture via MediaProjection.
///
/// [prepare] shows the OS MediaProjection consent dialog
/// (`Hardware().requestCapturePermission()`, which also stores the projection
/// token so the subsequent capture reuses it without a second dialog). When the
/// user consents it starts the app's `mediaProjection` foreground service — which
/// MUST already be running before the SDK calls `getMediaProjection()` on
/// Android 10–14, since neither LiveKit nor flutter_webrtc provides one. A
/// decline returns false (no service, no error). [release] stops that service.
class AndroidScreenCaptureController implements ScreenCaptureController {
  const AndroidScreenCaptureController();

  @override
  Future<bool> prepare() async {
    // The OS consent dialog; also stores the projection token for the capture
    // that follows. False means the user declined — a normal outcome.
    // `requestCapturePermission` is the ONLY public API for Android MediaProjection
    // consent in the pinned SDK; it is marked experimental there (a no-op that
    // returns true off Android/macOS), so the use is acknowledged deliberately.
    // ignore: experimental_member_use
    final granted = await Hardware.instance.requestCapturePermission();
    if (!granted) return false;
    // Bring up the foreground service BEFORE the SDK starts the projection, so
    // `getMediaProjection()` finds a running `mediaProjection` service (required
    // on Android 10+, strictly enforced on 14+). A platform failure here
    // propagates so the client surfaces a media error rather than a half-start.
    await screenCaptureChannel.invokeMethod<void>('startService');
    return true;
  }

  @override
  Future<void> release() async {
    try {
      await screenCaptureChannel.invokeMethod<void>('stopService');
    } on Object {
      // Best-effort: the viewer stopped sharing; a failed service teardown is
      // not something they can act on and must not surface.
    }
  }
}

/// iOS screen capture via a ReplayKit broadcast upload extension (ADR 0051).
///
/// The room is created with `ScreenShareCaptureOptions(useiOSBroadcastExtension:
/// true)` (see `livekit_room_port.dart`), so the SDK publishes the frames the
/// broadcast extension feeds it. [prepare] asks the native host to present the
/// system broadcast picker (`RPSystemBroadcastPickerView`); [release] asks it to
/// stop. These go over the same method channel as Android but to iOS-only
/// handlers — the pinned SDK's `BroadcastManager` is not part of its public API,
/// so the picker is presented natively rather than from Dart.
///
/// NOTE: this Dart wiring compiles and is correct by construction, but a working
/// iOS broadcast REQUIRES the extension target, App Group, entitlements, the
/// Info.plist keys and the native method-channel handler that only an Xcode
/// build can produce and only a real device can validate — see
/// `ios/BroadcastExtension/README.md`. It is UNVERIFIED on this platform and must
/// not be treated as complete.
class IosScreenCaptureController implements ScreenCaptureController {
  const IosScreenCaptureController();

  @override
  Future<bool> prepare() async {
    // Present the system broadcast picker natively. This is only a request — the
    // user may still decline; publication is driven by the broadcast actually
    // starting, never faked here. A missing native handler surfaces as a media
    // error (iOS is unverified), never a pretended success.
    await screenCaptureChannel.invokeMethod<void>('presentBroadcastPicker');
    return true;
  }

  @override
  Future<void> release() async {
    try {
      await screenCaptureChannel.invokeMethod<void>('stopBroadcast');
    } on Object {
      // Best-effort stop; a no-op if no broadcast is in progress.
    }
  }
}
