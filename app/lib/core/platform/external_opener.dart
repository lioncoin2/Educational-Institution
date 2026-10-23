/// Opening a URL in a new browser tab — the web-first way to view or download
/// a signed attachment link, or to follow a link in a message.
///
/// Only the web build can do it, so the real implementation is swapped in by
/// conditional import (exactly as the URL strategy and invitation links are),
/// and every other target gets the stub, which throws [UnsupportedError] so a
/// caller can fall back to telling the viewer it is unavailable in this build.
library;

export 'external_opener_stub.dart'
    if (dart.library.js_interop) 'external_opener_web.dart';
