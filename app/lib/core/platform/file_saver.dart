/// Saving a file the app received (an export) to the viewer's device.
///
/// Only the web build can do it — the browser's own download — so the real
/// implementation is swapped in by conditional import, as [external_opener]
/// is, and every other target gets the stub, which throws [UnsupportedError]
/// so the caller can say it is unavailable in this build.
library;

export 'file_saver_stub.dart' if (dart.library.js_interop) 'file_saver_web.dart';
