/// Chooses the web URL strategy without dragging web-only libraries into the
/// iOS and Android builds.
///
/// `flutter_web_plugins` exists only on the web, so the real implementation is
/// swapped in by conditional import and everything else gets the no-op.
library;

export 'url_strategy_stub.dart'
    if (dart.library.js_interop) 'url_strategy_web.dart';
