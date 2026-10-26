import 'package:flutter/foundation.dart';

/// Native (non-web) screen-capture capability.
///
/// Off by default: native capture needs platform plumbing (Android
/// `mediaProjection` foreground service, iOS ReplayKit broadcast extension, ADR
/// 0051), so a build opts in explicitly via [nativeScreenShareEnabled]
/// (`LIVE_MEDIA_NATIVE_SCREEN_SHARE_ENABLED`). Only iOS and Android have a real
/// capture path; desktop targets stay unsupported. A plain widget test on the VM
/// (no opt-in) therefore reads false, so the "share screen" control stays
/// disabled with an accurate message rather than offering a capture that cannot
/// run.
bool screenCaptureSupported({
  required TargetPlatform platform,
  required bool nativeScreenShareEnabled,
}) {
  if (!nativeScreenShareEnabled) return false;
  return platform == TargetPlatform.android || platform == TargetPlatform.iOS;
}
