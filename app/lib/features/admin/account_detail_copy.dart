import '../../data/models/auth.dart' show AccountStatus;

/// What the account-detail / lifecycle screen says, in one place. Role and
/// status labels are reused from [AdminCopy]; this holds the detail-specific
/// strings and the lifecycle error mapper. No password or credential is ever
/// composed into a sentence here.
abstract final class AccountDetailCopy {
  static const title = 'الحساب';
  static const refresh = 'تحديث';
  static const loadError = 'تعذّر تحميل الحساب. حاول مرة أخرى.';

  static const identifiersSection = 'معرّفات الدخول';
  static const rolesSection = 'الأدوار';
  static const noRoles = 'لا أدوار بعد';
  static const managementSection = 'إدارة الحساب';
  static const demoBanner = 'إدارة الحسابات تتم على الخادم.';
  static const selfNote = 'لا يمكنك إدارة حسابك من هذه الشاشة.';
  static const nextStepPending =
      'حساب جديد دون أدوار. أسنِد دورًا ثم فعّله ليصبح قابلًا للاستخدام.';

  // ── Roles ──
  static const assignRole = 'إسناد دور';
  static const assignRoleTitle = 'اختر دورًا للإسناد';
  static const removeRole = 'إزالة الدور';
  static const noAssignableRoles = 'لا أدوار متاحة للإسناد.';
  static String confirmAssign(String role, String name) =>
      'إسناد دور «$role» إلى «$name»؟ يمنح هذا الحساب صلاحيات الدور. يتحقق الخادم من أنك تملك صلاحية منحه.';
  static String confirmRemove(String role, String name) =>
      'إزالة دور «$role» من «$name»؟ تُسحب صلاحيات هذا الدور.';
  static const roleAssigned = 'تم إسناد الدور.';
  static const roleRemoved = 'تمت إزالة الدور.';

  // ── Status ──
  static const changeStatus = 'تغيير الحالة';
  static const changeStatusTitle = 'إلى أي حالة؟';
  static const statusChanged = 'تم تغيير الحالة.';
  static const noStatusChanges = 'لا تغييرات حالة متاحة.';
  static String confirmStatus(String targetLabel, String effect) =>
      'التغيير إلى «$targetLabel»؟ $effect';

  /// The effect of moving to [status] — explained before confirmation.
  static String effectOf(AccountStatus status) => switch (status) {
    AccountStatus.active =>
      'يصبح بإمكان صاحب الحساب تسجيل الدخول واستخدام التطبيق.',
    AccountStatus.suspended =>
      'يُمنع تسجيل الدخول وتُنهى كل الجلسات النشطة. يمكن إعادة التفعيل لاحقًا.',
    AccountStatus.disabled =>
      'يُعطّل الحساب وتُنهى كل الجلسات. يمكن إعادة التفعيل لاحقًا.',
    AccountStatus.pending || AccountStatus.unknown => '',
  };

  // ── Password ──
  static const resetPassword = 'تعيين كلمة مرور جديدة';
  static const resetPasswordTitle = 'كلمة مرور جديدة';
  static const newPasswordLabel = 'كلمة المرور الجديدة';
  static const newPasswordHint = '٨ أحرف على الأقل';
  static const confirmPasswordLabel = 'تأكيد كلمة المرور';
  static const passwordMismatch = 'كلمتا المرور غير متطابقتين.';
  static const passwordTooShort = 'كلمة المرور قصيرة جدًا (٨ أحرف على الأقل).';
  static const setPasswordAction = 'تعيين';
  static const passwordUpdated = 'تم تعيين كلمة المرور.';

  // ── Sessions ──
  static const revokeSessions = 'إنهاء كل الجلسات';
  static const revokeSessionsExplain =
      'تُنهى كل جلسات الحساب النشطة، وسيحتاج صاحبه إلى تسجيل الدخول من جديد.';
  static const confirmRevoke = 'إنهاء الجلسات';
  static String sessionsEnded(int count) =>
      count == 0 ? 'لا جلسات نشطة لإنهائها.' : 'تم إنهاء $count جلسة.';

  static const cancel = 'تراجع';
  static const confirm = 'تأكيد';

  /// Why a lifecycle action did not go through — by the server's code, said
  /// without exposing any credential or input.
  static String actionFailed(String code) => switch (code) {
    'identity.self_administration' => selfNote,
    'identity.target_outranks_actor' =>
      'هذا الحساب يملك صلاحيات لا تملكها، فلا يمكنك إدارته.',
    'identity.role_outranks_actor' =>
      'هذا الدور يحمل صلاحيات لا تملكها، فلا يمكنك منحه.',
    'identity.role_unknown' => 'هذا الدور غير معروف.',
    'identity.status_transition_invalid' => 'تغيير الحالة هذا غير مسموح.',
    'identity.account_pending' => 'هذا الإجراء غير متاح على حساب قيد الانتظار.',
    'identity.password_too_short' => passwordTooShort,
    'identity.user_not_found' => 'لم يُعثر على الحساب.',
    'identity.permission_denied' => 'هذا الإجراء غير متاح لك.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر إتمام العملية. حاول مرة أخرى.',
  };
}
