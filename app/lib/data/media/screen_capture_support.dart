/// Whether this platform/browser can actually capture the screen
/// (`getDisplayMedia`). Only the web implementation feature-detects it; every
/// other target (and a widget test on the Dart VM) gets the stub `false`.
///
/// Why this exists: screen capture is a browser capability, not a LiveKit or an
/// app fact. iOS Safari — in fact every browser on iOS — exposes no
/// `getDisplayMedia`, so a presenter there must be told plainly, and not offered
/// a "share screen" button that can only fail. Swapped in by conditional import,
/// exactly as the URL strategy and invite-link seams are.
library;

export 'screen_capture_support_stub.dart'
    if (dart.library.js_interop) 'screen_capture_support_web.dart';
