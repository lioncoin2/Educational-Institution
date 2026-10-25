import 'package:flutter/foundation.dart';

/// Whether this platform runs the real live-media client (LiveKit).
///
/// - The web keeps its behavior: supported (still gated by the build's
///   `LIVE_MEDIA_ENABLED` and backend mode, see `liveMediaClientProvider`).
/// - iOS and Android are supported only when the native build opts in
///   ([nativeEnabled], `LIVE_MEDIA_NATIVE_ENABLED`); the app declares the
///   microphone permission on both, and the SDK asks for it at runtime.
/// - Every other target (desktop, or a native build without the opt-in) falls
///   closed to the Unavailable client, and the live screen says so.
///
/// Native media is audio only: screen sharing stays a web capability
/// (`screenCaptureSupported` is false off the web).
bool liveMediaPlatformSupported({
  required bool isWeb,
  required TargetPlatform platform,
  required bool nativeEnabled,
}) {
  if (isWeb) return true;
  if (!nativeEnabled) return false;
  return platform == TargetPlatform.android || platform == TargetPlatform.iOS;
}
