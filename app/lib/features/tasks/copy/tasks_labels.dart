import '../../../data/models/tasks/tasks.dart';

/// The Arabic names of the tasks engine's vocabularies and refusals (ADR 0052).
/// Codes come from the server; the sentences are the app's.
abstract final class TasksLabels {
  static String audience(TaskAudience value) => switch (value) {
    TaskAudience.teachers => 'المعلمات',
    TaskAudience.supervisors => 'المشرفات',
    TaskAudience.administration => 'الإدارة',
    TaskAudience.unknown => '—',
  };

  static String audienceWire(String wire) => audience(TaskAudience.fromWire(wire));

  static String button(TaskButton value) => switch (value) {
    TaskButton.acknowledge => 'تم الاستلام',
    TaskButton.complete => 'تم الإكمال',
    TaskButton.unknown => '—',
  };

  static String kind(TaskKind value) => switch (value) {
    TaskKind.general => 'مهمة عامة',
    TaskKind.attendance => 'حضور',
    TaskKind.teaching => 'تدريس',
    TaskKind.unknown => '—',
  };

  static String approval(ApprovalMode value) => switch (value) {
    ApprovalMode.manual => 'اعتماد من الإدارة',
    ApprovalMode.auto => 'اعتماد تلقائي',
    ApprovalMode.unknown => '—',
  };

  static String state(TaskState value) => switch (value) {
    TaskState.active => 'نشطة',
    TaskState.archived => 'مؤرشفة',
    TaskState.cancelled => 'ملغاة',
    TaskState.unknown => '—',
  };

  static String assignment(AssignmentStatus value) => switch (value) {
    AssignmentStatus.pending => 'لم تستلم بعد',
    AssignmentStatus.acknowledged => 'تم الاستلام',
    AssignmentStatus.completed => 'مكتملة',
    AssignmentStatus.reassigned => 'أُعيد إسنادها',
    AssignmentStatus.unknown => '—',
  };

  static String report(ReportStatus value) => switch (value) {
    ReportStatus.pendingReview => 'بانتظار المراجعة',
    ReportStatus.approved => 'معتمد',
    ReportStatus.changesRequested => 'مطلوب تعديل',
    ReportStatus.deleted => 'محذوف',
    ReportStatus.unknown => '—',
  };

  static String category(ReportCategory value) => switch (value) {
    ReportCategory.taskCompletion => 'تقارير إنجاز المهام',
    ReportCategory.attendance => 'تقارير الحضور',
    ReportCategory.teachers => 'تقارير المعلمات',
    ReportCategory.unknown => '—',
  };

  static String decision(ReviewDecision value) => switch (value) {
    ReviewDecision.approved => 'اعتماد',
    ReviewDecision.changesRequested => 'طلب تعديل',
    ReviewDecision.unknown => '—',
  };

  static String tracking(TrackingFilter value) => switch (value) {
    TrackingFilter.all => 'الكل',
    TrackingFilter.responded => 'استلموا',
    TrackingFilter.notResponded => 'لم يستلموا',
    TrackingFilter.completed => 'أكملوا',
    TrackingFilter.notCompleted => 'لم يكملوا',
  };

  /// One act of the operation log.
  static String action(String code) => switch (code) {
    'TASK_PUBLISHED' => 'نُشرت المهمة',
    'TASK_EDITED' => 'عُدّلت المهمة',
    'TASK_CANCELLED' => 'أُلغيت المهمة',
    'TASK_REOPENED' => 'أُعيد فتح المهمة',
    'TASK_ARCHIVED' => 'أُرشفت المهمة',
    'TASK_REMINDED' => 'أُرسل تذكير لغير المستجيبين',
    'ASSIGNMENT_ACKNOWLEDGED' => 'تم الاستلام',
    'ASSIGNMENT_COMPLETED' => 'تم الإكمال',
    'ASSIGNMENT_REASSIGNED' => 'أُعيد الإسناد',
    'REPORT_SUBMITTED' => 'أُرسل تقرير',
    'REPORT_EDITED' => 'عُدّل تقرير',
    'REPORT_DELETED' => 'حُذف تقرير',
    'REPORT_APPROVED' => 'اعتُمد تقرير',
    'REPORT_CHANGES_REQUESTED' => 'طُلب تعديل تقرير',
    _ => 'عملية',
  };

  /// A refusal, as a sentence.
  static String error(Object error) => refusal(error is TasksException ? error.code : null);

  /// The sentence for a server code (or a check the screen makes first).
  static String refusal(String? code) {
    return switch (code) {
      'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
      'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
      'identity.permission_denied' => 'لا تملك صلاحية هذا الإجراء.',
      'tasks.demo_unavailable' => 'المهام اليومية تحتاج إلى الاتصال بخادم المعهد.',
      'tasks.unreadable' => 'وصلت من الخادم بيانات لا يستطيع التطبيق قراءتها.',
      'tasks.title_required' => 'اكتب عنوان المهمة.',
      'tasks.title_too_long' => 'عنوان المهمة أطول من المسموح.',
      'tasks.body_too_long' => 'نص المهمة أطول من المسموح.',
      'tasks.audience_invalid' => 'اختر فئة واحدة على الأقل.',
      'tasks.no_recipients' => 'لا يوجد في الفئة المختارة أحد تصله المهمة.',
      'tasks.community_not_found' => 'المجموعة المختارة غير موجودة.',
      'tasks.no_way_to_respond' => 'اختر زرًّا واحدًا على الأقل أو اطلب تقريرًا، ليستطيع المستلم الرد.',
      'tasks.settings_invalid' => 'إعدادات المهمة غير صالحة.',
      'tasks.settings_locked' =>
        'لا يمكن تغيير الإعدادات بعد أن استجاب أحد؛ يمكن تعديل العنوان والنص فقط.',
      'tasks.revision_conflict' || 'tasks.changed_meanwhile' =>
        'عدّل شخص آخر هذه المهمة في الأثناء. حدّث الصفحة ثم أعد المحاولة.',
      'tasks.report_version_conflict' =>
        'تغيّر التقرير في الأثناء. حدّث الصفحة ثم أعد المحاولة.',
      'tasks.task_not_found' => 'المهمة غير موجودة.',
      'tasks.assignment_not_found' => 'هذه المهمة غير متاحة لك.',
      'tasks.report_not_found' => 'التقرير غير موجود.',
      'tasks.template_not_found' => 'القالب غير موجود.',
      'tasks.task_not_active' => 'المهمة ليست نشطة.',
      'tasks.task_not_reopenable' => 'لا يمكن إعادة فتح هذه المهمة.',
      'tasks.assignment_closed' => 'أُعيد إسناد هذه المهمة إلى شخص آخر.',
      'tasks.assignment_not_pending' => 'لا يمكن إعادة إسناد مهمة اكتملت.',
      'tasks.acknowledge_first' => 'اضغط «تم الاستلام» أولًا.',
      'tasks.no_acknowledge' => 'هذه المهمة لا تطلب الاستلام.',
      'tasks.no_complete_button' => 'هذه المهمة لا تطلب الإكمال.',
      'tasks.complete_by_acknowledge' => 'تكتمل هذه المهمة بالاستلام.',
      'tasks.report_required' => 'هذه المهمة تتطلب تقريرًا نصيًّا.',
      'tasks.report_too_long' => 'التقرير أطول من المسموح.',
      'tasks.report_not_pending' => 'هذا التقرير ليس بانتظار المراجعة.',
      'tasks.note_required' => 'اكتب ملاحظة توضّح المطلوب تعديله.',
      'tasks.note_too_long' => 'الملاحظة أطول من المسموح.',
      'tasks.reassign_target_invalid' =>
        'لا يمكن الإسناد إلى هذا الشخص: يجب أن يكون نشطًا ومن فئة المهمة ولا يحملها بالفعل.',
      _ => 'تعذّر إتمام العملية. حاول مرة أخرى.',
    };
  }
}
