import '../../data/models/auth.dart' show AccountStatus;

/// What the admin account screens say, in one place: the server speaks in
/// stable codes and enum values, the person reads Arabic sentences. No password
/// or identifier is ever composed into a sentence here.
abstract final class AdminCopy {
  static const screenTitle = 'إدارة الحسابات';
  static const refresh = 'تحديث';
  static const retry = 'إعادة المحاولة';
  static const loadMore = 'عرض المزيد';
  static const loadMoreFailed = 'تعذّر التحميل — إعادة المحاولة';

  static const empty = 'لا توجد حسابات لعرضها';
  static const emptyMessage =
      'تظهر هنا حسابات المعهد. أنشئ حسابًا جديدًا للبدء.';
  static const loadError = 'تعذّر تحميل الحسابات. حاول مرة أخرى.';
  static const demoBanner =
      'حسابات تجريبية للعرض فقط. عند ربط التطبيق بالخادم تظهر الحسابات الحقيقية هنا.';

  // ── Creating an account (users.manage) ──
  static const createAccount = 'إنشاء حساب';
  static const createAccountTitle = 'إنشاء حساب جديد';
  static const nameLabel = 'الاسم';
  static const nameHint = 'اسم صاحب الحساب';
  static const emailLabel = 'البريد الإلكتروني';
  static const passwordLabel = 'كلمة المرور المبدئية';
  static const passwordHint = '٨ أحرف على الأقل';
  static const createAccountAction = 'إنشاء';
  static const accountCreated = 'تم إنشاء الحساب.';

  /// An account the directory shows with no identifier (never a bare id).
  static const noIdentifier = 'بلا معرّف';

  /// Shown instead of an email to a reader who may not administer accounts.
  static const identifierWithheld = 'معرّف الدخول متاح لمن يدير الحسابات فقط';
  static const noRoles = 'بلا دور بعد';

  static String roles(List<String> codes) =>
      codes.isEmpty ? noRoles : codes.map(role).join('، ');

  static String role(String code) => switch (code) {
    'OWNER' => 'المالكة',
    'ADMIN' => 'الإدارة',
    'SUPERVISOR' => 'مشرفة',
    'TEACHER' => 'معلمة',
    'ASSISTANT_TEACHER' => 'معلمة مساعدة',
    'STUDENT' => 'طالبة',
    _ => code,
  };

  /// A status the server does not know degrades to a neutral word.
  static String status(AccountStatus status) => switch (status) {
    AccountStatus.pending => 'قيد الانتظار',
    AccountStatus.active => 'نشط',
    AccountStatus.suspended => 'موقوف',
    AccountStatus.disabled => 'معطّل',
    AccountStatus.unknown => 'غير معروف',
  };

  /// Why a new account was not created — by the server's code, said without
  /// exposing anything typed.
  static String createFailed(String code) => switch (code) {
    'identity.identifier_taken' => 'يوجد حساب بهذا البريد الإلكتروني بالفعل.',
    'identity.identifier_invalid' => 'البريد الإلكتروني غير صالح.',
    'identity.password_too_short' =>
      'كلمة المرور قصيرة جدًا (٨ أحرف على الأقل).',
    'identity.password_too_long' => 'كلمة المرور طويلة جدًا.',
    'identity.password_blank' => 'كلمة المرور مطلوبة.',
    'identity.permission_denied' => 'إنشاء الحسابات غير متاح لك.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر إنشاء الحساب. حاول مرة أخرى.',
  };
}
