/// What the live-session screen says, in one place (the community_copy.dart
/// convention): the server speaks in stable codes and states, the person reads
/// Arabic sentences. Nothing here states a rule the server did not send, and no
/// account id is ever put in a sentence.
abstract final class LiveCopy {
  static const title = 'الجلسة المباشرة';
  static const refresh = 'تحديث';
  static const retry = 'إعادة المحاولة';

  static const liveNow = 'جلسة مباشرة الآن';
  static const noSession = 'لا توجد جلسة مباشرة الآن';
  static const noSessionMessage =
      'تظهر هنا الجلسة المباشرة لهذا المجتمع عند انطلاقها.';

  /// How many hold the floor now.
  static String speakers(int count) => 'المتحدثون الآن: $count';

  static const youHost = 'أنت تستضيف هذه الجلسة';
  static const youModerate = 'أنت من المشرفين على هذه الجلسة';

  /// The media (audio) area. Said plainly so the screen never implies that
  /// joining or voice works in this build.
  static const audioSection = 'الصوت المباشر';
  static const audioUnavailable = 'الصوت المباشر غير متاح في هذا الإصدار بعد.';
  static const audioUnavailableMessage =
      'عرض الجلسة متاح الآن؛ الانضمام الصوتي سيُضاف لاحقًا.';

  static const demoBanner = 'جلسة مباشرة تجريبية للعرض فقط.';

  static String error(String? code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'live.community_not_found' ||
    'live.session_not_found' => 'هذه الجلسة غير متاحة لك.',
    'communities.capability_required' ||
    'identity.permission_denied' ||
    'live.not_a_moderator' => 'هذا غير متاح لك في هذا المجتمع.',
    'live.unreadable' =>
      'وصلت من الخادم بيانات لا يقرؤها هذا الإصدار من التطبيق.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر عرض الجلسة المباشرة.',
  };
}
