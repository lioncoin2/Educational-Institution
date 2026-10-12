/// Where the backend is, if anywhere.
///
/// Set at build time — never a secret, only an address:
///
///   flutter run --dart-define=API_BASE_URL=https://api.example.org
///
/// When it is absent (the GitHub Pages demo, every widget test) the app runs
/// entirely on its in-memory mock repositories and says so on screen.
abstract final class BackendConfig {
  static const String apiBaseUrl = String.fromEnvironment('API_BASE_URL');

  static bool get isConfigured => apiBaseUrl.isNotEmpty;

  static Uri get baseUri =>
      Uri.parse(apiBaseUrl.endsWith('/') ? apiBaseUrl : '$apiBaseUrl/');

  /// Whether this build activates the real live-media client (LiveKit). Off by
  /// default — never a secret, only a switch — so a build opts in explicitly:
  ///
  ///   flutter build web \
  ///     --dart-define=API_BASE_URL=https://api.example.org \
  ///     --dart-define=LIVE_MEDIA_ENABLED=true
  ///
  /// Even when true, the real client is bound ONLY in backend mode and only on
  /// the supported web target (see `liveMediaClientProvider`); the demo build,
  /// an absent/false flag, and an unsupported platform all fall closed to the
  /// Unavailable default. The flag enables no native (iOS/Android) media — that
  /// stays a separate slice (ADR 0030).
  static const bool liveMediaEnabled = bool.fromEnvironment('LIVE_MEDIA_ENABLED');
}
