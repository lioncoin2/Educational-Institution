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
/// This decides AUDIO (whether the real client is bound). Screen SHARE is a
/// separate capability with its own opt-in and platform plumbing — see
/// `screen_capture_support.dart` and ADR 0051 — so native screen share is NOT
/// implied by this flag.
bool liveMediaPlatformSupported({
  required bool isWeb,
  required TargetPlatform platform,
  required bool nativeEnabled,
}) {
  if (isWeb) return true;
  if (!nativeEnabled) return false;
  return platform == TargetPlatform.android || platform == TargetPlatform.iOS;
}
