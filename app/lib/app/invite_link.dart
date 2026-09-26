/// Invitation links in the browser: reading a token from the address the app
/// was opened with (or navigated to), and writing the link to a new one.
///
/// Only the web has an address bar, so the real implementation is swapped
/// in by conditional import and everything else gets the stub — as for the
/// URL strategy. What needs no browser is in `invite_link_parts.dart`.
library;

export 'invite_link_stub.dart'
    if (dart.library.js_interop) 'invite_link_web.dart';
