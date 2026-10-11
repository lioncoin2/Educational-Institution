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

  /// The session has ended — shown when the server's state is no longer live.
  static const sessionEnded = 'انتهت هذه الجلسة';
  static const sessionEndedMessage = 'لم تعد هذه الجلسة مباشرة الآن.';

  // ── Moderator tools (Slice 6) ─────────────────────────────────────────
  // Every control is shown only when the server's own `me` flag allows it;
  // nothing here decides who may act.
  static const controlsSection = 'أدوات الإشراف';
  static const cancel = 'إلغاء';

  /// How many hands wait for a moderator's decision, as the server counts
  /// them (100 means "100 or more"). A count only — never the queue itself.
  static String pendingHands(int count) => 'طلبات الكلمة المنتظرة: $count';

  static const endSession = 'إنهاء الجلسة';
  static const endSessionQuestion = 'هل تريد إنهاء الجلسة المباشرة للجميع؟';
  static const endSessionConfirm = 'إنهاء';
  static const endSessionDone = 'تم إنهاء الجلسة.';

  static const resetRoom = 'إعادة ضبط الغرفة';
  static const resetRoomQuestion =
      'إعادة ضبط غرفة الجلسة؟ سيُعاد اتصال المشاركين بها.';
  static const resetRoomConfirm = 'إعادة الضبط';
  static const resetRoomDone = 'تمت إعادة ضبط الغرفة.';

  /// The presenter (screen-share) slot — an authoritative role the server
  /// tracks. The screen capture itself is media (unavailable in this build,
  /// said in [audioUnavailableMessage]); this only takes or releases the slot.
  static const youPresent = 'أنت من مُقدّمي العرض في هذه الجلسة';
  static const claimPresenter = 'تولّي دور العرض';
  static const claimPresenterDone = 'أصبحت من مُقدّمي العرض.';
  static const stopPresenter = 'إيقاف تقديمك';
  static const stopPresenterDone = 'أوقفت تقديمك.';

  // ── The hands/speakers roster (Slice 7 — Q56/Q64) ─────────────────────
  // The moderator's view of who has a raised hand or holds the floor, with the
  // per-person authority commands (remove from the session; delegate or revoke
  // a screen-share slot). Shown only when the server's own `me.canModerate`
  // allows it; every command still goes to the server, which decides afresh. A
  // name is the directory's; a person without one shows [participantFallback],
  // never an account id.
  static const rosterSection = 'طلبات الكلمة والمتحدثون';
  static const rosterFilterTooltip = 'تصفية القائمة';
  static const rosterFilterAll = 'الكل';
  static const rosterFilterPending = 'طلبات منتظرة';
  static const rosterFilterGranted = 'المتحدثون';
  static const rosterEmpty = 'لا توجد طلبات كلمة أو متحدثون الآن.';
  static const rosterError = 'تعذّر عرض القائمة.';
  static const rosterLoadMore = 'عرض المزيد';
  static const rosterLoadMoreFailed = 'تعذّر التحميل. إعادة المحاولة';

  /// A person with no name the directory could resolve — a neutral word, never
  /// an account id in a sentence.
  static const participantFallback = 'مشارك';

  /// A hand's lifecycle, in words (the roster queries pending/granted, but a
  /// value a newer server adds is said neutrally).
  static const handPending = 'طلب كلمة';
  static const handGranted = 'يحمل الكلمة';
  static const handOther = 'طلب سابق';

  /// A granted hand's last-observed connection — a display hint, never truth.
  static const mediaConnected = 'متصل';
  static const mediaNotConnected = 'غير متصل';

  /// That this person holds a screen-share (presenter) slot now (Q56). The
  /// capture itself is media, unavailable in this build.
  static const presenterBadge = 'مُقدّم عرض';

  /// Remove a participant from the session (Q64) — an administrative
  /// disconnect, never a ban; they may re-join at once.
  static const removeParticipant = 'إزالة من الجلسة';
  static const removeParticipantQuestion =
      'إزالة هذا المشارك من الجلسة؟ يمكنه الانضمام إليها من جديد.';
  static const removeParticipantConfirm = 'إزالة';
  static const removeParticipantDone = 'تمت إزالة المشارك من الجلسة.';

  /// Delegate / revoke a screen-share (presenter) slot (Q56). The slot is an
  /// authority the server tracks; the screen capture is media (unavailable in
  /// this build). Granting does not give the microphone or the floor.
  static const grantPresenter = 'منح دور العرض';
  static const grantPresenterDone = 'تم منح دور العرض.';
  static const revokePresenter = 'سحب دور العرض';
  static const revokePresenterDone = 'تم سحب دور العرض.';

  /// What became of a moderator command — the server's code, in words. Kept
  /// apart from [error] (which is about failing to DISPLAY the session).
  static String commandError(String? code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'live.session_not_found' ||
    'live.community_not_found' => 'لم تعد هذه الجلسة متاحة.',
    'communities.capability_required' ||
    'identity.permission_denied' ||
    'live.not_a_moderator' ||
    'live.presenter_not_permitted' ||
    'live.target_is_host' => 'هذا الإجراء غير متاح لك.',
    'live.presenter_slots_full' => 'اكتمل عدد مُقدّمي العرض.',
    'live.session_not_live' => 'لم تعد الجلسة مباشرة.',
    'unavailable' ||
    'live.media_unavailable' ||
    'live.media_misconfigured' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر تنفيذ الإجراء.',
  };

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
