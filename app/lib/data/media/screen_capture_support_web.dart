import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

/// True only when this browser actually exposes `navigator.mediaDevices
/// .getDisplayMedia` — the one API LiveKit's screen share needs. Feature
/// detection, never a user-agent guess: iOS browsers (all WebKit) lack it and
/// return false; a secure desktop Chrome/Firefox/Edge returns true. In an
/// insecure context `mediaDevices` is absent, which the guard treats as false.
bool screenCaptureSupported() {
  try {
    final md = web.window.navigator.mediaDevices;
    return (md as JSObject).has('getDisplayMedia');
  } catch (_) {
    return false;
  }
}
