import '../../data/models/academic.dart'
    show AssignmentStatus, EnrollmentOutcome, EnrollmentStatus, TeachingRole;

/// What the halaqa people-administration screen says, in one place. The server
/// speaks in stable codes and enum values; the person reads Arabic sentences.
/// No email, role list or account-security state is ever composed here — a
/// person is only ever a name (or a neutral fallback) and, where it matters,
/// whether the account is still active.
abstract final class AcademicPeopleCopy {
  static const screenTitle = 'طلاب الحلقة ومعلّموها';
  static const studentsTab = 'الطلاب';
  static const teachersTab = 'المعلّمون';
  static const refresh = 'تحديث';
  static const loadError = 'تعذّر التحميل. حاول مرة أخرى.';
  static const loadMore = 'عرض المزيد';
  static const loadMoreFailed = 'تعذّر التحميل — إعادة المحاولة';
  static const demoBanner = 'إدارة الطلاب والمعلّمين تتم على الخادم.';

  static const noStudents = 'لا يوجد طلاب مسجّلون بعد';
  static const noStudentsMessage = 'سجّل طالبًا في هذه الحلقة للبدء.';
  static const noTeachers = 'لا يوجد معلّمون مُسنَدون بعد';
  static const noTeachersMessage = 'أسنِد معلّمًا لهذه الحلقة للبدء.';

  static const enrollStudent = 'تسجيل طالب';
  static const assignTeacher = 'إسناد معلّم';
  static const unnamed = 'بلا اسم';
  static const inactiveAccount = 'حساب موقوف';

  // ── People picker (people.read directory — OWNER/ADMIN) ──
  static const pickStudentTitle = 'اختر طالبًا';
  static const pickTeacherTitle = 'اختر معلّمًا';
  static const searchHint = 'ابحث بالاسم';
  static const searchPrompt = 'اكتب اسمًا للبحث في دليل المعهد.';
  static const noMatches = 'لا نتائج مطابقة';
  static const pickerHint =
      'يتحقّق الخادم من أهلية الحساب عند الإضافة؛ لا يكفي الاسم.';

  // ── Roles ──
  static const roleLabel = 'الدور';
  static const chooseRoleTitle = 'دور المعلّم';
  static String role(TeachingRole r) => switch (r) {
    TeachingRole.teacher => 'معلّم',
    TeachingRole.assistantTeacher => 'معلّم مساعد',
    TeachingRole.unknown => 'غير معروف',
  };

  // ── Outcomes / confirmations ──
  static const endEnrollment = 'إنهاء التسجيل';
  static const endAssignment = 'إنهاء الإسناد';
  static const assignmentStatusLabel = 'الحالة';

  static String endEnrollmentQuestion(String name) =>
      'كيف يُنهى تسجيل «$name»؟ يبقى محفوظًا في السجل ولا يُحذف.';
  static String outcomeLabel(EnrollmentOutcome o) => switch (o) {
    EnrollmentOutcome.completed => 'أتمّ',
    EnrollmentOutcome.withdrawn => 'انسحب',
  };

  static String endAssignmentQuestion(String name) =>
      'إنهاء إسناد «$name» لهذه الحلقة؟ يبقى محفوظًا في السجل ولا يُحذف.';
  static const confirmEnd = 'إنهاء';
  static const cancel = 'تراجع';

  // ── Success toasts ──
  static const enrolled = 'تم التسجيل.';
  static const assigned = 'تم الإسناد.';
  static const enrollmentEnded = 'تم إنهاء التسجيل.';
  static const assignmentEnded = 'تم إنهاء الإسناد.';

  static String enrollmentStatus(EnrollmentStatus s) => switch (s) {
    EnrollmentStatus.active => 'نشط',
    EnrollmentStatus.completed => 'مكتمل',
    EnrollmentStatus.withdrawn => 'منسحب',
    EnrollmentStatus.unknown => 'غير معروف',
  };

  static String assignmentStatus(AssignmentStatus s) => switch (s) {
    AssignmentStatus.active => 'نشط',
    AssignmentStatus.ended => 'منتهٍ',
    AssignmentStatus.unknown => 'غير معروف',
  };

  /// Why a discovery search was refused — told without exposing anything.
  static String searchFailed(String code) => switch (code) {
    'identity.permission_denied' => 'البحث في دليل الأشخاص غير متاح لك.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر البحث الآن. حاول مرة أخرى.',
  };

  /// Why an enrol / assign / end did not go through — by the server's code.
  /// Eligibility is the server's to decide; the name is never the proof.
  static String relationFailed(String code) => switch (code) {
    'academic.student_not_eligible' =>
      'هذا الحساب ليس طالبًا نشطًا مؤهّلًا للدراسة.',
    'academic.teacher_not_eligible' =>
      'هذا الحساب ليس معلّمًا نشطًا مؤهّلًا للتدريس.',
    'academic.halaqa_not_found' => 'لم يُعثر على الحلقة.',
    'academic.halaqa_inactive' => 'الحلقة موقوفة؛ فعّلها أولًا.',
    'academic.program_inactive' ||
    'academic.section_inactive' => 'العنصر الأب موقوف.',
    'academic.enrollment_already_ended' =>
      'انتهى هذا التسجيل مسبقًا بنتيجة مختلفة.',
    'academic.enrollment_not_found' => 'لم يُعثر على التسجيل.',
    'academic.teacher_already_assigned' =>
      'المعلّم مُسنَد بالفعل بدور مختلف. أنهِ الإسناد الحالي أولًا.',
    'academic.teacher_assignment_not_found' => 'لم يُعثر على الإسناد.',
    'academic.outcome_invalid' => 'نتيجة غير صالحة.',
    'academic.role_invalid' => 'دور غير صالح.',
    'academic.status_filter_invalid' => 'عامل تصفية غير صالح.',
    'academic.historical_roster_denied' =>
      'عرض السجل التاريخي غير متاح عبر هذا المسار.',
    'academic.halaqa_access_denied' => 'لا تملك صلاحية الوصول لهذه الحلقة.',
    'identity.permission_denied' => 'هذا الإجراء غير متاح لك.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    'academic.unsupported_in_demo' =>
      'إدارة العلاقات غير متاحة في العرض التجريبي.',
    _ => 'تعذّر إتمام العملية. حاول مرة أخرى.',
  };
}
