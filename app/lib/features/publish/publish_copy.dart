import '../../data/models/publication.dart';

/// What the mass-publish screen says, in one place. The server owns the
/// per-community verdicts; this only renders them in Arabic.
abstract final class PublishCopy {
  static const title = 'النشر الجماعي';

  static const composeTitle = 'المحتوى';
  static const textHint = 'اكتب إعلانًا أو تعليقًا للمرفق…';
  static const attachImage = 'صورة';
  static const attachDocument = 'مستند PDF';
  static const recordVoice = 'تسجيل صوتي';
  static const stopRecording = 'إيقاف التسجيل';
  static const recording = 'جارٍ التسجيل…';
  static const removeAttachment = 'إزالة المرفق';
  static const mediaUnavailable = 'المرفقات غير متاحة في هذه النسخة.';

  static const targetsTitle = 'المجتمعات المستهدفة';
  static const targetsEmpty = 'لا توجد مجتمعات لعرضها.';
  static const targetsError = 'تعذّر تحميل المجتمعات.';
  static const noCommunitiesHint = 'اختر مجتمعًا واحدًا على الأقل.';

  static const publish = 'نشر';
  static const retryFailed = 'إعادة محاولة المتعثّر';

  static const resultsTitle = 'نتيجة النشر';

  static String summary(PublicationReport report) =>
      'نُشر في ${report.posted} من ${report.total}'
      '${report.failed > 0 ? '، تعذّر ${report.failed}' : ''}.';

  /// The per-community verdict, in a word.
  static String status(PublicationStatus status) => switch (status) {
    PublicationStatus.posted => 'تم النشر',
    PublicationStatus.alreadyPosted => 'سبق نشره',
    PublicationStatus.forbidden => 'لا تملك صلاحية النشر هنا',
    PublicationStatus.notFound => 'لست عضوًا أو المجتمع غير موجود',
    PublicationStatus.locked => 'المجتمع مقفل',
    PublicationStatus.overCapacity => 'المجتمع أكبر من المتاح للنشر',
    PublicationStatus.rateLimited => 'محاولات كثيرة، أعد لاحقًا',
    PublicationStatus.unavailable => 'الخدمة غير متاحة الآن',
    PublicationStatus.failed => 'تعذّر النشر',
    PublicationStatus.unknown => 'نتيجة غير معروفة',
  };

  /// A request-level refusal (nothing was published), by the server's code.
  static String error(String? code) => switch (code) {
    'messaging.attachment_not_found' => 'المرفق غير موجود أو ليس ملكك.',
    'messaging.attachment_not_ready' => 'لم يكتمل رفع المرفق بعد.',
    'messaging.attachment_kind_invalid' => 'نوع الملف لا يصلح لهذا النشر.',
    'messaging.publish_body_required' => 'النشر النصّي يحتاج محتوى.',
    'messaging.publish_too_many_targets' => 'عدد المجتمعات كبير جدًا.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'identity.permission_denied' => 'لا تملك صلاحية النشر.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر النشر.',
  };
}
