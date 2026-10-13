import '../../data/models/academic.dart' show TeachingRole;

/// What the teacher workspace says, in one place. The teacher sees only their
/// own halaqat (the server answers by the authenticated identity) and, within
/// one, that halaqa's current students — never an institution-wide directory
/// and never a management control. Arabic sentences from the server's codes.
abstract final class TeacherCopy {
  static const workspaceTitle = 'حلقاتي كمعلّم';
  static const refresh = 'تحديث';
  static const empty = 'لا حلقات مُسنَدة إليك';
  static const emptyMessage =
      'عندما تُسنَد إليك حلقة ستظهر هنا. الإسناد يتم على يد الإدارة.';
  static const demoBanner = 'حلقات المعلّم تُقرأ من الخادم.';
  static const truncatedNote = 'تُعرض أحدث الحلقات؛ قد توجد حلقات أخرى.';
  static const viewStudents = 'عرض الطلاب';

  static const rosterTitle = 'طلاب الحلقة';
  static const noStudents = 'لا طلاب في هذه الحلقة';
  static const noStudentsMessage = 'لا يوجد طلاب مسجّلون في هذه الحلقة حاليًا.';
  static const loadMore = 'عرض المزيد';
  static const loadMoreFailed = 'تعذّر التحميل — إعادة المحاولة';
  static const inactiveAccount = 'حساب موقوف';
  static const unnamed = 'بلا اسم';

  static String role(TeachingRole r) => switch (r) {
    TeachingRole.teacher => 'معلّم',
    TeachingRole.assistantTeacher => 'معلّم مساعد',
    TeachingRole.unknown => 'غير معروف',
  };

  /// Why the teacher's own halaqat could not be loaded.
  static String workspaceFailed(String code) => switch (code) {
    'identity.permission_denied' => 'هذه الصفحة غير متاحة لك.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    'academic.unsupported_in_demo' =>
      'حلقات المعلّم غير متاحة في العرض التجريبي.',
    _ => 'تعذّر تحميل حلقاتك. حاول مرة أخرى.',
  };

  /// Why a halaqa's students could not be loaded — a teacher reaches only the
  /// halaqat they are actively assigned to; the server decides.
  static String rosterFailed(String code) => switch (code) {
    'academic.halaqa_access_denied' =>
      'لا تملك صلاحية الوصول لطلاب هذه الحلقة.',
    'academic.historical_roster_denied' =>
      'عرض السجل الكامل غير متاح عبر هذا المسار.',
    'academic.halaqa_not_found' => 'لم يُعثر على الحلقة.',
    'identity.permission_denied' => 'عرض الطلاب غير متاح لك.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    'academic.unsupported_in_demo' => 'الطلاب غير متاحين في العرض التجريبي.',
    _ => 'تعذّر تحميل الطلاب. حاول مرة أخرى.',
  };
}
