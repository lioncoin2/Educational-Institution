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
  /// a supported platform (see `liveMediaClientProvider`); the demo build, an
  /// absent/false flag, and an unsupported platform all fall closed to the
  /// Unavailable default. On its own the flag enables the web only; native
  /// iOS/Android media also needs [liveMediaNativeEnabled].
  static const bool liveMediaEnabled = bool.fromEnvironment('LIVE_MEDIA_ENABLED');

  /// Whether a NATIVE (iOS/Android) build also activates the real live-media
  /// client. Off by default — a second, explicit opt-in on top of
  /// [liveMediaEnabled], so a native build carries live audio only once it is
  /// deliberately enabled (the web is unaffected by it):
  ///
  ///   flutter build apk \
  ///     --dart-define=API_BASE_URL=https://api.example.org \
  ///     --dart-define=LIVE_MEDIA_ENABLED=true \
  ///     --dart-define=LIVE_MEDIA_NATIVE_ENABLED=true
  static const bool liveMediaNativeEnabled = bool.fromEnvironment(
    'LIVE_MEDIA_NATIVE_ENABLED',
  );

  /// Whether a NATIVE build also activates screen SHARING (publishing the
  /// device screen), on top of native audio. A THIRD, separate opt-in: native
  /// screen capture needs platform plumbing that audio does not — on Android a
  /// `mediaProjection` foreground service, on iOS a ReplayKit broadcast
  /// extension (ADR 0051) — so it is enabled deliberately and independently of
  /// [liveMediaNativeEnabled]. It is meaningful only when [liveMediaNativeEnabled]
  /// is also true (no live client is bound otherwise); the provider wiring ANDs
  /// the two. The web is unaffected (it feature-detects `getDisplayMedia`).
  ///
  ///   flutter build apk \
  ///     --dart-define=API_BASE_URL=https://api.example.org \
  ///     --dart-define=LIVE_MEDIA_ENABLED=true \
  ///     --dart-define=LIVE_MEDIA_NATIVE_ENABLED=true \
  ///     --dart-define=LIVE_MEDIA_NATIVE_SCREEN_SHARE_ENABLED=true
  static const bool liveMediaNativeScreenShareEnabled = bool.fromEnvironment(
    'LIVE_MEDIA_NATIVE_SCREEN_SHARE_ENABLED',
  );
}
