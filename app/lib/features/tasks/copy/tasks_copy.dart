/// The Arabic text of the daily tasks & reports screens (ADR 0052).
abstract final class TasksCopy {
  // ── Entry points ─────────────────────────────────────────────────────
  static const myTasksTitle = 'مهامي';
  static const adminTitle = 'المهام اليومية';
  static const reportsTitle = 'التقارير';
  static const dashboardTitle = 'إحصاءات المهام';
  static const templatesTitle = 'قوالب المهام';

  // ── Common ───────────────────────────────────────────────────────────
  static const refresh = 'تحديث';
  static const loadMore = 'عرض المزيد';
  static const loadMoreFailed = 'تعذّر تحميل المزيد.';
  static const confirm = 'تأكيد';
  static const back = 'تراجع';
  static const save = 'حفظ';
  static const unknownPerson = 'حساب غير معروف';
  static const unknownCommunity = 'مجموعة لست عضوًا فيها';
  static const system = 'النظام';

  // ── My tasks ─────────────────────────────────────────────────────────
  static const openTab = 'قيد التنفيذ';
  static const doneTab = 'المنجزة';
  static const myEmpty = 'لا توجد مهام هنا';
  static const myEmptyMessage = 'تظهر هنا المهام التي تصلك من الإدارة.';
  static const instructions = 'التعليمات';
  static const receivedAt = 'وصلت';
  static const acknowledgedAt = 'تم الاستلام';
  static const completedAt = 'تم الإكمال';
  static const reportLabel = 'التقرير';
  static const reportHint = 'اكتب تقريرك هنا';
  static const reportRequiredHint = 'هذه المهمة تتطلب تقريرًا نصيًّا عند الإكمال.';
  static const sendReport = 'إرسال التقرير';
  static const updateReport = 'تحديث التقرير';
  static const reviewerNotes = 'ملاحظات المراجعة';
  static const acknowledged = 'تم تسجيل الاستلام';
  static const completed = 'تم تسجيل الإكمال';
  static const reportSent = 'تم إرسال التقرير';

  // ── Administration list & filters ────────────────────────────────────
  static const newTask = 'مهمة جديدة';
  static const search = 'ابحث في العنوان والنص';
  static const filters = 'تصفية';
  static const clearFilters = 'مسح التصفية';
  static const anyAudience = 'كل الفئات';
  static const anyKind = 'كل الأنواع';
  static const anyState = 'كل الحالات';
  static const anyReportStatus = 'كل حالات التقارير';
  static const fromDate = 'من تاريخ';
  static const toDate = 'إلى تاريخ';
  static const adminEmpty = 'لا توجد مهام';
  static const adminEmptyMessage = 'انشر مهمة لتصل إلى المعلمات أو المشرفات أو الإدارة.';
  static String countsLine(int responded, int completed, int targets) =>
      'استلم $responded · أكمل $completed من $targets';

  // ── Composer ─────────────────────────────────────────────────────────
  static const composeTitle = 'نشر مهمة';
  static const editTitle = 'تعديل المهمة';
  static const republishTitle = 'إعادة نشر مهمة';
  static const titleField = 'عنوان المهمة';
  static const bodyField = 'التعليمات';
  static const audiencesField = 'إلى';
  static const communityField = 'تضييق إلى مجموعة (اختياري)';
  static const communityNone = 'كل أفراد الفئات المختارة';
  static const kindField = 'نوع المهمة';
  static const buttonsField = 'أزرار الرد';
  static const reportRequired = 'تتطلب تقريرًا نصيًّا';
  static const approvalField = 'اعتماد التقرير';
  static const requireReacknowledge = 'اطلب من المستلمين تأكيد الاستلام من جديد';
  static const settingsLockedHint =
      'استجاب بعض المستلمين، فلا تتغير الإعدادات بعد الآن؛ يمكن تعديل العنوان والنص.';
  static const publish = 'نشر';
  static const saveEdit = 'حفظ التعديل';
  static const republish = 'إعادة النشر';
  static const saveAsTemplate = 'حفظ كقالب';
  static const published = 'تم نشر المهمة';
  static const edited = 'تم حفظ التعديل';
  static const republished = 'تم نشر المهمة من جديد';
  static const templateSaved = 'تم حفظ القالب';
  static const titleMissing = 'اكتب عنوان المهمة';
  static const audienceMissing = 'اختر فئة واحدة على الأقل';
  static const noResponseWay = 'اختر زرًّا أو اطلب تقريرًا';

  // ── One task (follow-up) ─────────────────────────────────────────────
  static const trackingTab = 'المتابعة';
  static const historyTab = 'السجل';
  static const revisionsTab = 'التعديلات';
  static const edit = 'تعديل';
  static const cancelTask = 'إلغاء المهمة';
  static const reopenTask = 'إعادة فتح';
  static const remind = 'تذكير غير المستجيبين';
  static const reassign = 'إعادة إسناد';
  static const reassignTo = 'أسند المهمة إلى';
  static const cancelQuestion = 'تُلغى المهمة وتُؤرشف، وتبقى سجلاتها. هل تريد المتابعة؟';
  static const reopenQuestion = 'تعود المهمة نشطة بكل سجلاتها. هل تريد المتابعة؟';
  static const cancelled = 'أُلغيت المهمة';
  static const reopened = 'أُعيد فتح المهمة';
  static const reassigned = 'تمت إعادة الإسناد';
  static String reminded(int count) =>
      count == 0 ? 'استجاب الجميع؛ لا أحد يحتاج تذكيرًا.' : 'أُرسل التذكير إلى $count';
  static String revisionLine(int revision) => 'المراجعة $revision';
  static const trackingEmpty = 'لا أحد في هذه القائمة';
  static const historyEmpty = 'لا توجد عمليات';
  static const publishedBy = 'نشرها';
  static const cancelledBy = 'ألغاها';
  static const reportOf = 'تقرير';
  static const replacedSomeone = 'بإعادة إسناد';

  // ── Reports ──────────────────────────────────────────────────────────
  static const reportsEmpty = 'لا توجد تقارير';
  static const reportsEmptyMessage = 'تظهر هنا تقارير المهام حسب تصنيفها.';
  static const versions = 'النسخ';
  static const reviews = 'المراجعات';
  static const approve = 'اعتماد';
  static const requestChanges = 'طلب تعديل';
  static const noteField = 'ملاحظة للمرسل';
  static const editReport = 'تعديل التقرير';
  static const deleteReport = 'حذف التقرير';
  static const deleteReportQuestion = 'يُحذف التقرير من القوائم ويبقى في السجل. هل تريد المتابعة؟';
  static const approvedToast = 'تم اعتماد التقرير';
  static const changesRequestedToast = 'أُرسل طلب التعديل';
  static const reportEdited = 'تم تعديل التقرير';
  static const reportDeleted = 'تم حذف التقرير';
  static const approvedAutomatically = 'اعتُمد تلقائيًّا';
  static String approvedBy(String who) => 'اعتمده $who';
  static String versionLine(int version) => 'النسخة $version';

  // ── Dashboard & export ───────────────────────────────────────────────
  static const totalsSection = 'الإجمالي';
  static const byAudienceSection = 'حسب الفئة';
  static const byCommunitySection = 'حسب المجموعة';
  static const byPersonSection = 'حسب الشخص';
  static const byPersonHint = 'مرتّبون أبجديًّا، دون أي ترتيب للأداء.';
  static const tasksCount = 'المهام';
  static const archivedCount = 'المؤرشفة';
  static const assignmentsCount = 'الإسنادات';
  static const ackRate = 'نسبة الاستلام';
  static const completionRate = 'نسبة الإكمال';
  static const completedCount = 'مكتملة';
  static const notCompletedCount = 'غير مكتملة';
  static const approvedCount = 'تقارير معتمدة';
  static const changesCount = 'تقارير مطلوب تعديلها';
  static const pendingCount = 'تقارير بانتظار المراجعة';
  static const noRate = '—';
  static const exportCsv = 'تصدير Excel (CSV)';
  static const exportHtml = 'تقرير للطباعة / PDF';
  static const exported = 'تم تنزيل الملف';
  static const exportTruncated = 'التصدير بلغ الحد الأقصى؛ ضيّق التصفية لتنزيل الباقي.';
  static const exportUnsupported = 'التنزيل متاح في نسخة الويب من التطبيق.';
  static const printHint = 'افتح الملف في المتصفح واطبعه أو احفظه PDF.';

  // ── Templates ────────────────────────────────────────────────────────
  static const templatesEmpty = 'لا توجد قوالب';
  static const templatesEmptyMessage = 'احفظ مهمة كقالب لتعيد نشرها لاحقًا.';
  static const useTemplate = 'نشر من القالب';
  static const deleteTemplate = 'حذف القالب';
  static const deleteTemplateQuestion = 'يُحذف القالب، ولا تتأثر المهام المنشورة منه. هل تريد المتابعة؟';
  static const templateDeleted = 'تم حذف القالب';
}
