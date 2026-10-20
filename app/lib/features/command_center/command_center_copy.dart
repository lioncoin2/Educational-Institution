/// What the Owner Command Center says, in one place (the live_copy.dart
/// convention): the server speaks in stable widget ids, categories and metric
/// labels; the person reads Arabic. Nothing here states a figure or a rule the
/// server did not send.
abstract final class CommandCenterCopy {
  static const title = 'لوحة المالك';
  static const refresh = 'تحديث';
  static const retry = 'إعادة المحاولة';

  static const empty = 'لا توجد ملخصات لعرضها الآن';
  static const emptyMessage =
      'تظهر هنا ملخصات المؤسسة التي يُسمح لك بالاطلاع عليها، فور توفّرها.';

  static const demoBanner =
      'لوحة تجريبية للعرض فقط؛ الأرقام تأتي من الخادم في الوضع الحقيقي.';

  /// The quick-actions section heading.
  static const actionsTitle = 'إجراءات سريعة';

  /// Tapping an action the server offers but this app build has no screen for.
  static const actionUnavailable = 'هذا الإجراء غير متاح في هذا التطبيق بعد.';

  /// A widget with no metric the server could read — shown plainly, never as a
  /// fabricated zero.
  static const noData = 'لا تتوفّر بيانات لهذا الملخّص الآن.';

  /// A category heading, from the server's category key.
  static String category(String key) => switch (key) {
    'today' => 'نظرة اليوم',
    'attention' => 'يحتاج انتباهك',
    'pending_decisions' => 'قرارات معلّقة',
    'quick_actions' => 'إجراءات سريعة',
    'activity' => 'النشاط',
    'kpi' => 'مؤشرات',
    _ => 'ملخّصات',
  };

  /// A failed load, said in a word — the server's code, in Arabic.
  static String error(String? code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'identity.permission_denied' => 'هذه اللوحة غير متاحة لك.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر عرض اللوحة.',
  };
}
