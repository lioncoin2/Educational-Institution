import 'backend_config.dart';

/// Prototype-wide switches.
///
/// This whole file disappears once the app is backed by a real service.
abstract final class AppConfig {
  /// Shows the amber "بيانات تجريبية" ribbons — only in the in-memory demo
  /// build. Against a real backend ([BackendConfig.isConfigured], e.g. the
  /// Trial build) the data is the server's, so the demo ribbons must not show.
  static bool get showMockRibbons => !BackendConfig.isConfigured;

  /// Artificial latency so loading states are visible and the screens are
  /// written against async data from day one.
  static const Duration fakeLatency = Duration(milliseconds: 180);

  /// Shown only in the demo build; a connected build gates its display on
  /// [BackendConfig.isConfigured] at the call sites (splash, profile).
  static const String stageLabel = 'نموذج أولي — واجهات فقط';
}
