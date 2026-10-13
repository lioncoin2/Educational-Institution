/// What the read-only academic-history screens say. Status and role labels are
/// reused from [AcademicPeopleCopy]; this holds the history-specific strings,
/// a plain date formatter, and the error mapper. Only fields the server returns
/// are ever shown — no placement, date or reason is invented.
abstract final class AcademicHistoryCopy {
  static const studentTitle = 'سجل تسجيل الطالب';
  static const teacherTitle = 'سجل إسناد المعلّم';
  static const refresh = 'تحديث';
  static const loadMore = 'عرض المزيد';
  static const loadMoreFailed = 'تعذّر التحميل — إعادة المحاولة';

  static const noEnrollments = 'لا سجلّ تسجيل';
  static const noEnrollmentsMessage = 'لا توجد تسجيلات لهذا الحساب بعد.';
  static const noAssignments = 'لا سجلّ إسناد';
  static const noAssignmentsMessage = 'لا توجد إسنادات لهذا الحساب بعد.';
  static const demoBanner = 'السجل الأكاديمي يُقرأ من الخادم.';

  static const enrolledOn = 'بدأ';
  static const startedOn = 'بدأ';
  static const endedOn = 'انتهى';

  /// A plain calendar date (no time) — dependency-free, unambiguous.
  static String date(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${d.year}-${two(d.month)}-${two(d.day)}';
  }

  /// Why a history read was refused — by the server's code, told plainly.
  static String historyFailed(String code) => switch (code) {
    'academic.historical_roster_denied' ||
    'identity.permission_denied' => 'عرض السجل الأكاديمي غير متاح لك.',
    'academic.user_not_found' ||
    'identity.user_not_found' => 'لم يُعثر على الحساب.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    'academic.unsupported_in_demo' =>
      'السجل الأكاديمي غير متاح في العرض التجريبي.',
    _ => 'تعذّر تحميل السجل. حاول مرة أخرى.',
  };
}
