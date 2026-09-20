import 'package:flutter_web_plugins/url_strategy.dart';

/// Real paths instead of `#/…` fragments, so a route can be copied, shared and
/// opened directly.
///
/// The host must serve `index.html` for unknown paths. `flutter run -d chrome`
/// and `tool/serve_web.py` both do; a bare static host needs a fallback (a copy
/// of `index.html` as `404.html` is enough on GitHub Pages).
void configureUrlStrategy() => usePathUrlStrategy();
