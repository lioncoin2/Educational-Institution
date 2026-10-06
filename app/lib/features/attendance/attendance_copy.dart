/// What the attendance record screen says, in one place (the live_copy.dart
/// convention): the server speaks in stable codes, the person reads Arabic.
///
/// Nothing here states a rule the server did not send, and no account id is
/// put in a sentence. A snapshot's counts are **connections**, never a verdict
/// of "present" or "absent" and never a ratio (attendance.md §12/§17): the
/// words below are متصل (connected) and قيد الاتصال (connecting), and there is
/// deliberately no حاضر، غائب or نسبة حضور anywhere.
abstract final class AttendanceCopy {
  static const title = 'جمع الحضور';
  static const refresh = 'تحديث';
  static const retry = 'إعادة المحاولة';

  // No live session to record against.
  static const noSession = 'لا توجد جلسة مباشرة الآن';
  static const noSessionMessage =
      'يُجمع الحضور أثناء جلسة مباشرة قائمة؛ تظهر هنا عند انطلاقها.';

  // A session that is no longer running.
  static const sessionNotLive = 'الجلسة المباشرة غير قائمة الآن.';

  // Reached without a basis to record (the server remains the final authority).
  static const cannotRecordMessage =
      'جمع الحضور متاح لمن يملك صلاحيته أو لمشرفي الجلسة.';

  // The live-session context and the record action.
  static const liveNow = 'جلسة مباشرة الآن';
  static const recordButton = 'جمع الحضور الآن';
  static const recording = 'يُجمع الحضور…';
  static const recordAgain = 'جمع مرة أخرى';

  // The result — connection counts only, not a presence verdict.
  static const resultTitle = 'تمّ جمع الحضور';

  static String connected(int count) => 'متصل: $count';

  static String connecting(int count) => 'قيد الاتصال: $count';

  static String recordedBy(String? name) =>
      name == null ? 'سُجِّل الحضور' : 'سجّله: $name';

  static const demoBanner = 'بيانات حضور تجريبية للعرض فقط.';

  static String error(String? code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'attendance.session_not_found' ||
    'attendance.not_allowed' => 'جمع الحضور غير متاح لك هنا.',
    'attendance.session_not_live' => 'الجلسة المباشرة غير قائمة الآن.',
    'attendance.community_not_open' => 'هذا المجتمع غير مفتوح الآن.',
    'attendance.too_many_snapshots' => 'محاولات كثيرة متتابعة. حاول بعد قليل.',
    'attendance.observation_unavailable' ||
    'attendance.unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    'attendance.unreadable' =>
      'وصلت من الخادم بيانات لا يقرؤها هذا الإصدار من التطبيق.',
    _ => 'تعذّر جمع الحضور.',
  };
}
