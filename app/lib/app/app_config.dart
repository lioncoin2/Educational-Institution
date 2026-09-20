/// Prototype-wide switches.
///
/// This whole file disappears once the app is backed by a real service.
abstract final class AppConfig {
  /// Shows the amber "بيانات تجريبية" ribbons. Turn off for a clean demo,
  /// but never for a stakeholder review — the ribbons are what keep the
  /// prototype honest about which numbers are real.
  static const bool showMockRibbons = true;

  /// Artificial latency so loading states are visible and the screens are
  /// written against async data from day one.
  static const Duration fakeLatency = Duration(milliseconds: 180);

  static const String stageLabel = 'نموذج أولي — واجهات فقط';
}
