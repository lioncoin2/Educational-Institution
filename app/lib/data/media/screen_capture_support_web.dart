import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:flutter/foundation.dart';
import 'package:web/web.dart' as web;

/// Web screen-capture capability: true only when this browser actually exposes
/// `navigator.mediaDevices.getDisplayMedia` — the one API LiveKit's web screen
/// share needs. Feature detection, never a user-agent guess: iOS browsers (all
/// WebKit) lack it and return false; a secure desktop Chrome/Firefox/Edge
/// returns true. In an insecure context `mediaDevices` is absent, treated as
/// false.
///
/// The [platform] and [nativeScreenShareEnabled] arguments exist only to share
/// one signature with the native implementation (conditional import); the web
/// decision is always the feature probe and ignores them.
bool screenCaptureSupported({
  required TargetPlatform platform,
  required bool nativeScreenShareEnabled,
}) {
  try {
    final md = web.window.navigator.mediaDevices;
    return (md as JSObject).has('getDisplayMedia');
  } catch (_) {
    return false;
  }
}
