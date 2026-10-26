/// The platform lifecycle a screen SHARE needs around the SDK's publish, kept
/// behind a seam so the LiveKit client orchestrates it without knowing the
/// platform.
///
/// Why a seam: starting screen capture is not a single SDK call on native. On
/// Android the OS asks for MediaProjection consent and the app must run a
/// `mediaProjection` foreground service (with a persistent notification) for as
/// long as it captures; on iOS the user starts a ReplayKit system broadcast. On
/// the web the browser's `getDisplayMedia` prompt handles consent and there is
/// nothing extra to run. This interface is that "prepare the device, then
/// release it" contract — plain Dart, no LiveKit, no platform channel — so the
/// client stays testable and each platform's real plumbing lives in one adapter
/// (`livekit/screen_capture_controllers.dart`, ADR 0051).
abstract interface class ScreenCaptureController {
  /// Prepare the device to capture the screen: obtain any system consent and
  /// start any platform resource (e.g. the Android foreground service) that
  /// must already be running before the SDK begins capturing.
  ///
  /// Returns true when capture may proceed, false when the user declined (a
  /// normal outcome, NOT an error — the caller simply does not start). Throws
  /// only on an unexpected platform failure, which the caller surfaces as a
  /// media error.
  Future<bool> prepare();

  /// Release the platform resources a prepared capture held (e.g. stop the
  /// foreground service). Always safe to call — a no-op when nothing was
  /// prepared — and must not throw: a cleanup failure is not something the
  /// viewer can act on.
  Future<void> release();
}

/// The default on platforms that need no extra plumbing: the web (the browser's
/// own `getDisplayMedia` prompt is the consent step) and any build without
/// native screen capture. [prepare] reports "proceed" and [release] does
/// nothing, so the client's screen-share path is unchanged where no platform
/// resource is involved.
class NoopScreenCaptureController implements ScreenCaptureController {
  const NoopScreenCaptureController();

  @override
  Future<bool> prepare() async => true;

  @override
  Future<void> release() async {}
}
