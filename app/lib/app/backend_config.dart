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
}
