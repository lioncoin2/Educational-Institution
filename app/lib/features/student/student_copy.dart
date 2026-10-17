import '../../data/models/academic.dart' show TeachingRole;

/// What the student workspace says, in one place. The student sees only their
/// OWN current enrollments (the server answers by the authenticated identity)
/// and, within each, that halaqa's teachers by name and role — never a roster
/// of classmates (Q31) and never a management control. There is no progress or
/// assessment here: none is recorded yet, and none is invented. Arabic
/// sentences map the server's codes.
abstract final class StudentCopy {
  static const workspaceTitle = 'حلقاتي';
  static const refresh = 'تحديث';
  static const empty = 'لست مسجَّلًا في أي حلقة';
  static const emptyMessage =
      'عندما تُسجَّل في حلقة ستظهر هنا. التسجيل يتم على يد الإدارة.';
  static const demoBanner = 'حلقات الطالب تُقرأ من الخادم.';
  static const truncatedNote = 'تُعرض أحدث الحلقات؛ قد توجد حلقات أخرى.';
  static const teachersLabel = 'المعلّمون';
  static const noTeachers = 'لم يُسنَد معلّم بعد.';
  static const unnamed = 'بلا اسم';

  /// Start (or reopen) a direct conversation with this halaqa's teacher. The
  /// affordance is shown only to a viewer the server would let start a teacher
  /// DM; the server re-authorises every start.
  static const messageTeacher = 'مراسلة المعلّم';

  // ── The student's own academic record (every enrollment, current & past) ──
  static const recordTitle = 'سجلّي الدراسي';
  static const recordEntry = 'سجلّي الدراسي';
  static const recordEmpty = 'لا سجلّ دراسي بعد';
  static const recordEmptyMessage =
      'ستظهر هنا تسجيلاتك في الحلقات، الحالية والسابقة.';

  static String role(TeachingRole r) => switch (r) {
    TeachingRole.teacher => 'معلّم',
    TeachingRole.assistantTeacher => 'معلّم مساعد',
    TeachingRole.unknown => 'غير معروف',
  };

  /// Why the student's own halaqat could not be loaded.
  static String workspaceFailed(String code) => switch (code) {
    'identity.permission_denied' => 'هذه الصفحة غير متاحة لك.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    'academic.unsupported_in_demo' => 'حلقات الطالب غير متاحة في العرض التجريبي.',
    _ => 'تعذّر تحميل حلقاتك. حاول مرة أخرى.',
  };
}
