import '../../data/models/notifications.dart';

/// What notifications say, in one place. The server sends stable keys and
/// plain values (`notification.message_received.title`, `senderDisplayName`);
/// the sentences are the app's, in Arabic. A key this version does not know
/// reads as a generic notification — never as a raw key, never as an error.
///
/// Parameters are inserted as plain text: nothing in them is interpreted.
abstract final class NotificationCopy {
  static const screenTitle = 'الإشعارات';
  static const settingsTitle = 'إعدادات الإشعارات';
  static const markAllRead = 'تحديد الكل كمقروء';
  static const settings = 'إعدادات الإشعارات';
  static const empty = 'لا توجد إشعارات';
  static const emptyMessage = 'تظهر هنا الرسائل الجديدة وما يخصّك من المعهد.';
  static const signInTitle = 'سجّل الدخول لعرض إشعاراتك';
  static const signIn = 'تسجيل الدخول';
  static const loadMore = 'عرض المزيد';
  static const retry = 'إعادة المحاولة';
  static const loadMoreFailed = 'تعذّر تحميل المزيد.';
  static const demoBanner =
      'إشعارات تجريبية للعرض فقط. عند ربط التطبيق بالخادم تظهر إشعاراتك '
      'الحقيقية هنا.';

  /// The destination was deleted, or the person may no longer see it.
  static const contentGone = 'هذا المحتوى لم يعد متاحًا.';

  /// A notification from a newer server, leading somewhere this version
  /// cannot go.
  static const unsupported =
      'لا يمكن فتح هذا الإشعار في هذا الإصدار من التطبيق.';

  static String error(String? code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'notifications.notification_not_found' => contentGone,
    _ => 'تعذّر إتمام العملية. حاول مرة أخرى.',
  };

  // ── What one notification says ─────────────────────────────────────────

  static String title(AppNotification n) => switch (n.titleKey) {
    'notification.message_received.title' => switch (n.text('messageType')) {
      'VOICE' => 'رسالة صوتية جديدة',
      'IMAGE' => 'صورة جديدة',
      'FILE' => 'ملف جديد',
      _ => 'رسالة جديدة',
    },
    'notification.conversation_created.title' => 'محادثة جديدة',
    'notification.added_to_conversation.title' => 'أُضفت إلى محادثة',
    'notification.assignment_created.title' => 'واجب جديد',
    'notification.assignment_updated.title' => 'تحديث على واجب',
    'notification.announcement_created.title' => 'إعلان جديد',
    'notification.certificate_issued.title' => 'شهادة جديدة',
    'notification.halaqa_update.title' => 'تحديث في الحلقة',
    _ => 'إشعار جديد',
  };

  static String body(AppNotification n) {
    switch (n.bodyKey) {
      case 'notification.message_received.body':
        final sender = n.text('senderDisplayName');
        return sender == null
            ? 'لديك رسالة جديدة.'
            : 'لديك رسالة جديدة من $sender.';
      case 'notification.conversation_created.body':
        final actor = n.text('actorDisplayName');
        if (actor == null) return 'أُضفت إلى محادثة جديدة.';
        return switch (n.text('conversationType')) {
          'DIRECT' => 'بدأ $actor محادثة معك.',
          'GROUP' => 'أضافك $actor إلى مجموعة جديدة.',
          'CHANNEL' => 'أضافك $actor إلى قناة جديدة.',
          _ => 'أضافك $actor إلى محادثة جديدة.',
        };
      case 'notification.added_to_conversation.body':
        final actor = n.text('actorDisplayName');
        return actor == null ? 'أُضفت إلى محادثة.' : 'أضافك $actor إلى محادثة.';
      case 'notification.assignment_created.body':
        return 'لديك واجب جديد.';
      case 'notification.assignment_updated.body':
        return 'طرأ تحديث على أحد واجباتك.';
      case 'notification.announcement_created.body':
        return 'نُشر إعلان جديد.';
      case 'notification.certificate_issued.body':
        return 'صدرت لك شهادة جديدة.';
      case 'notification.halaqa_update.body':
        return 'طرأ تحديث على إحدى حلقاتك.';
      default:
        return 'لديك إشعار جديد.';
    }
  }

  /// "الآن", "قبل 5 دقائق", "أمس", then a date — with Arabic's number
  /// agreement (one, two, three to ten, eleven and more).
  static String relativeTime(DateTime at, DateTime now) {
    final elapsed = now.difference(at);
    if (elapsed.inMinutes < 1) return 'الآن';
    if (elapsed.inMinutes < 60) {
      return _ago(elapsed.inMinutes, 'دقيقة', 'دقيقتين', 'دقائق');
    }
    if (elapsed.inHours < 24) {
      return _ago(elapsed.inHours, 'ساعة', 'ساعتين', 'ساعات');
    }
    final days = elapsed.inDays;
    if (days == 1) return 'أمس';
    if (days < 7) return _ago(days, 'يوم', 'يومين', 'أيام');
    final local = at.toLocal();
    return '${local.day}/${local.month}/${local.year}';
  }

  static String _ago(int n, String one, String two, String few) => switch (n) {
    1 => 'قبل $one',
    2 => 'قبل $two',
    >= 3 && <= 10 => 'قبل $n $few',
    _ => 'قبل $n $one',
  };

  // ── The badge ──────────────────────────────────────────────────────────

  /// What a screen reader says for the bell.
  static String bellLabel(int unread) => switch (unread) {
    <= 0 => 'الإشعارات',
    > UnreadCount.cap => 'الإشعارات، أكثر من ${UnreadCount.cap} غير مقروءة',
    _ => 'الإشعارات، $unread غير مقروءة',
  };

  // ── Preferences ────────────────────────────────────────────────────────

  static String category(String code) => switch (code) {
    'MESSAGES' => 'الرسائل',
    'ASSIGNMENTS' => 'الواجبات',
    'ANNOUNCEMENTS' => 'الإعلانات',
    'CERTIFICATES' => 'الشهادات',
    'HALAQAT' => 'الحلقات',
    _ => 'أخرى',
  };

  static const inApp = 'داخل التطبيق';
  static const inAppHint = 'تظهر في مركز الإشعارات وتُحسب في الشارة.';
  static const realtime = 'فورًا أثناء استخدام التطبيق';
  static const realtimeHint = 'تصل لحظة حدوثها ما دام التطبيق مفتوحًا.';
  static const push = 'على الجهاز';
  static const pushHint =
      'تنبيه على شاشة الجهاز يقول «رسالة جديدة» فقط، دون اسم المرسل أو نص '
      'الرسالة.';
  static const pushUnavailable =
      'الإشعارات على الجهاز غير مفعّلة في هذه النسخة من التطبيق بعد؛ '
      'يُحفظ اختيارك ويُطبَّق حين تُفعَّل.';
  static const needsInApp =
      'عند إيقاف «داخل التطبيق» لا يُحفظ الإشعار، فلا يصل فورًا ولا على '
      'الجهاز.';
  static const saveFailed = 'تعذّر حفظ الإعداد. حاول مرة أخرى.';
}
