import '../../data/models/academic.dart' show SectionKind, StructureStatus;

/// What the academic-structure management screens say, in one place. The server
/// speaks in stable codes and enum values; the person reads Arabic sentences.
abstract final class AcademicAdminCopy {
  static const screenTitle = 'إدارة الهيكل الأكاديمي';
  static const refresh = 'تحديث';
  static const empty = 'لا توجد أقسام بعد';
  static const emptyMessage = 'أنشئ قسمًا للبدء ببناء هيكل المعهد.';
  static const demoBanner =
      'هيكل تجريبي للعرض فقط. إدارة الهيكل الأكاديمي تتم على الخادم.';

  static const noPrograms = 'لا توجد برامج في هذا القسم بعد.';
  static const noHalaqat = 'لا توجد حلقات في هذا البرنامج بعد.';

  // Actions
  static const addSection = 'إضافة قسم';
  static const addProgram = 'إضافة برنامج';
  static const addHalaqa = 'إضافة حلقة';
  static const edit = 'تعديل';
  static const activate = 'تفعيل';
  static const deactivate = 'إيقاف';
  static const manageHalaqat = 'إدارة الحلقات';
  static const managePeople = 'الطلاب والمعلّمون';
  static const changeCover = 'تغيير الغلاف';
  static const removeCover = 'إزالة الغلاف';

  static const created = 'تم الإنشاء.';
  static const saved = 'تم حفظ التعديل.';
  static const activated = 'تم التفعيل.';
  static const deactivated = 'تم الإيقاف.';
  static const coverUpdated = 'تم تحديث صورة الغلاف.';
  static const coverRemoved = 'تمت إزالة صورة الغلاف.';
  static const pickerUnavailable = 'اختيار الصور غير متاح على هذا الجهاز.';

  // Form
  static const createSectionTitle = 'إضافة قسم';
  static const createProgramTitle = 'إضافة برنامج';
  static const createHalaqaTitle = 'إضافة حلقة';
  static String editTitle(String name) => 'تعديل «$name»';
  static const codeLabel = 'الرمز';
  static const codeHint = 'أحرف لاتينية صغيرة وأرقام وشرطات، مثل tajweed-2';
  static const nameLabel = 'الاسم';
  static const orderLabel = 'الترتيب (رقم)';
  static const descriptionLabel = 'الوصف (اختياري)';
  static const kindLabel = 'نوع القسم';
  static const createAction = 'إنشاء';
  static const saveAction = 'حفظ';

  static String kind(SectionKind kind) => switch (kind) {
    SectionKind.progressive => 'متدرّج',
    SectionKind.special => 'خاص',
    SectionKind.accompanying => 'مرافق',
    SectionKind.unknown => 'غير معروف',
  };

  static String status(StructureStatus status) => switch (status) {
    StructureStatus.active => 'نشط',
    StructureStatus.inactive => 'موقوف',
    StructureStatus.unknown => 'غير معروف',
  };

  /// "N حلقة نشطة" — the active-halaqa count a program/section carries.
  static String activeHalaqat(int count) => 'حلقات نشطة: $count';

  // Deactivate confirmation — deactivate preserves history, never deletes.
  static String deactivateQuestion(String entity, String name) =>
      'إيقاف $entity «$name»؟ يبقى محفوظًا في السجل ولا يُحذف، لكنه لا يقبل '
      'تسجيلًا جديدًا. يمكن تفعيله لاحقًا.';
  static const confirmDeactivate = 'إيقاف';
  static const cancel = 'تراجع';
  static const sectionWord = 'القسم';
  static const programWord = 'البرنامج';
  static const halaqaWord = 'الحلقة';

  /// Why a create / edit / activate / deactivate did not go through — by the
  /// server's code, said without exposing anything typed.
  static String changeFailed(String code) => switch (code) {
    'academic.code_taken' => 'هذا الرمز مستخدم بالفعل.',
    'academic.code_invalid' =>
      'الرمز غير صالح (أحرف لاتينية صغيرة وأرقام وشرطات، من 2 إلى 64).',
    'academic.name_invalid' => 'الاسم غير صالح.',
    'academic.description_invalid' => 'الوصف غير صالح.',
    'academic.program_cover_invalid' ||
    'files.asset_kind_not_accepted' => 'يجب أن يكون الغلاف صورة رفعتها.',
    'academic.order_invalid' => 'الترتيب غير صالح (رقم من 1 إلى 10000).',
    'academic.kind_invalid' => 'نوع القسم غير صالح.',
    'academic.change_empty' => 'لا يوجد تغيير لحفظه.',
    'academic.section_not_found' ||
    'academic.program_not_found' ||
    'academic.halaqa_not_found' => 'لم يُعثر على هذا العنصر.',
    'academic.halaqa_has_active_enrollments' =>
      'لا يمكن إيقاف الحلقة ولها تسجيلات نشطة. أنهِ التسجيلات أولًا.',
    'academic.section_inactive' ||
    'academic.program_inactive' ||
    'academic.halaqa_inactive' => 'العنصر الأب موقوف.',
    final c when c.startsWith('academic.too_many_') =>
      'بلغت الحدّ الأقصى المسموح.',
    'identity.permission_denied' => 'هذا الإجراء غير متاح لك.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    'academic.unsupported_in_demo' =>
      'إدارة الهيكل غير متاحة في العرض التجريبي.',
    _ => 'تعذّر إتمام العملية. حاول مرة أخرى.',
  };

  static const loadError = 'تعذّر تحميل الهيكل. حاول مرة أخرى.';
}
