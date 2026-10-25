import '../../data/models/live_room.dart';

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

  // ── Live remote media (Sprint 11) ───────────────────────────────────────
  // What the moderator's OWN client actually hears/sees for a roster member
  // right now, matched by user id. A publication fact — NEVER speaking
  // detection, and never the presenter slot (authority).
  static const liveAudioOn = 'الميكروفون مفتوح';
  static const liveAudioMuted = 'الصوت مكتوم';
  static const liveScreenSharing = 'يشارك الشاشة الآن';

  /// The shared screen's full-screen viewer (opened from the stage).
  static const liveScreenExpand = 'عرض الشاشة المشتركة بملء الشاشة';
  static const liveScreenClose = 'إغلاق ملء الشاشة';

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

  // ── The floor: a participant's hand, and moderating it ─────────────────
  // A participant asks for the floor (raise a hand); a moderator gives it,
  // passes over it, or takes it back. The floor permits speaking (audio), which
  // is the media seam — unavailable in this build — never a claim audio flows.

  /// The viewer's own hand control (raise / lower). Shown only when the
  /// server's `me.canRaiseHand` allows it, or a hand is already up.
  static const handSection = 'المشاركة بالكلام';
  static const raiseHand = 'طلب الكلمة';
  static const raiseHandHint = 'اطلب الإذن للتحدث في الجلسة.';
  static const raiseHandDone = 'رُفعت يدك؛ بانتظار قرار المشرف.';
  static const lowerHand = 'خفض اليد';
  static const lowerHandDone = 'خفضت يدك.';
  static const yieldFloor = 'التخلّي عن الكلمة';
  static const yieldFloorDone = 'تخلّيت عن الكلمة.';

  /// The status of the viewer's own hand, in words.
  static const handStatusPending = 'طلبك لأخذ الكلمة بانتظار قرار المشرف.';
  static const handStatusGranted =
      'لديك الكلمة الآن (الصوت المباشر غير متاح في هذا الإصدار بعد).';

  /// A moderator's per-hand commands on the roster.
  static const grantFloor = 'منح الكلمة';
  static const grantFloorDone = 'تم منح الكلمة.';
  static const declineHand = 'رفض الطلب';
  static const declineHandDone = 'رُفض طلب الكلمة.';
  static const revokeFloor = 'سحب الكلمة';
  static const revokeFloorDone = 'تم سحب الكلمة.';

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
    'live.too_many_reactions' => 'تمهّل قليلًا قبل التفاعل مجددًا.',
    'unavailable' ||
    'live.media_unavailable' ||
    'live.media_misconfigured' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر تنفيذ الإجراء.',
  };

  /// The media (audio) area. In a build with no media provider bound it says
  /// plainly that audio is unavailable; when one is bound it carries the
  /// participation controls below.
  static const audioSection = 'الصوت المباشر';
  static const audioUnavailable = 'الصوت المباشر غير متاح في هذا الإصدار بعد.';
  static const audioUnavailableMessage =
      'عرض الجلسة متاح الآن؛ الانضمام الصوتي سيُضاف لاحقًا.';

  // ── Live media participation (Sprint 7) ───────────────────────────────
  // Joining the session's audio room, the microphone, and the screen-share
  // capture — the media TRANSPORT (the seam's), never authority. Who may join
  // or present is the server's `me`, never worked out here; joining is
  // EXPLICIT (the person asks), and nothing opens the microphone on its own.

  /// Join the audio — shown only when the server's `me.canJoin` allows it.
  static const audioJoin = 'الانضمام إلى الصوت';

  /// The server does not admit this viewer to the audio now.
  static const audioJoinUnavailable = 'الانضمام إلى الصوت غير متاح لك الآن.';
  static const audioIdlePrompt = 'انضم إلى صوت الجلسة للاستماع والمشاركة.';
  static const audioJoining = 'جارٍ الانضمام إلى الصوت…';
  static const audioConnectedTitle = 'أنت متصل بصوت الجلسة';

  /// Joining is not speaking: the microphone stays closed until asked for.
  static const audioConnectedHint =
      'شغّل الميكروفون عندما تريد التحدث؛ الانضمام وحده لا يفتحه.';

  /// A transient drop the SDK is recovering — not a reason to act.
  static const audioReconnecting = 'انقطع الاتصال مؤقتًا، وتجري إعادته…';
  static const audioLeave = 'مغادرة الصوت';
  static const audioRejoin = 'إعادة الانضمام';

  /// The app-wide bar over every other screen while this device is still in a
  /// live room (navigating away does not leave it).
  static const activeBarTitle = 'أنت في بث مباشر';
  static const activeBarReconnecting = 'يُعاد الاتصال بالبث…';
  static const activeBarMicOn = 'الميكروفون مفتوح';
  static const activeBarReturn = 'العودة';
  static const activeBarLeave = 'مغادرة';

  /// Terminal media states — the connection is no longer carrying audio.
  static const audioFailed = 'تعذّر الاتصال بصوت الجلسة.';
  static const audioDisconnected = 'انقطع الاتصال بصوت الجلسة.';
  static const audioEvicted =
      'تم الاتصال بهذا الحساب من جهاز آخر، فانتهى الاتصال هنا.';
  static const audioRemoved = 'أزالك أحد المشرفين من صوت الجلسة.';

  /// The microphone control — on/off is the LAST state the SDK confirmed, not
  /// a live speaking indicator. The backend token is the real ceiling; a
  /// publish it forbids surfaces as [micError], recoverably.
  static const micEnable = 'تشغيل الميكروفون';
  static const micDisable = 'كتم الميكروفون';
  static const micOnStatus = 'الميكروفون مُشغَّل';
  static const micOffStatus = 'الميكروفون مكتوم';
  static const micError =
      'تعذّر تشغيل الميكروفون. تحقّق من إذن الوصول إليه ثم أعد المحاولة.';

  /// The device refused microphone access (`microphone_blocked`): a denied
  /// permission or no usable mic — something only the viewer can change.
  static const micBlocked =
      'لا يملك التطبيق إذن الميكروفون. اسمح به من إعدادات الجهاز ثم أعد المحاولة.';

  /// The screen-share CAPTURE control — shown only to a current presenter
  /// (`me.presenting`, the server's authority). Starting it opens the browser
  /// picker; "on" means the SDK published the track (never merely that a slot
  /// was granted). A cancel, an unsupported browser or a refused grant all
  /// surface as [screenShareError], recoverably.
  static const screenShareStart = 'بدء مشاركة الشاشة';
  static const screenShareStop = 'إيقاف مشاركة الشاشة';
  static const screenShareOnStatus = 'مشاركة الشاشة مُفعّلة';

  /// The viewer holds the presenter slot, but the server's LIVE screen
  /// authorization has not yet reached this device — the start action waits for
  /// it (disabled) instead of offering a share that would be refused.
  static const screenShareConfirming = 'جارٍ تأكيد صلاحية مشاركة الشاشة…';
  static const screenShareError =
      'تعذّرت مشاركة الشاشة. قد لا يدعمها المتصفّح أو أنها غير متاحة الآن.';

  /// Shown when the browser exposes no screen-capture API at all (every iOS
  /// browser). Accurate and actionable — not the vaguer [screenShareError] used
  /// for a cancelled picker or a denied permission on a browser that supports it.
  static const screenShareUnsupported =
      'مشاركة الشاشة غير مدعومة على هذا المتصفّح/الجهاز. استخدم متصفّح حاسوب مكتبي (مثل Chrome أو Edge).';

  static const demoBanner = 'جلسة مباشرة تجريبية للعرض فقط.';

  // ── The immersive stage ────────────────────────────────────────────────
  /// The "on-air" pill on the broadcast stage.
  static const live = 'مباشر';

  /// How long an ended session ran, from its start and end instants.
  static String sessionDuration(Duration d) {
    final hours = d.inHours;
    final minutes = d.inMinutes.remainder(60);
    final parts = <String>[if (hours > 0) '$hours ساعة', '$minutes دقيقة'];
    return 'مدة الجلسة: ${parts.join(' و')}';
  }

  // ── Honest "coming later" hints ─────────────────────────────────────────
  // The reference design shows features the platform does not yet back; these
  // label them as inert, clearly-unavailable affordances — never as working
  // controls. ([soonBadge] is the tag every one of them carries.)
  static const soonSection = 'ميزات قادمة';
  static const soonBadge = 'غير متاح الآن';
  static const soonCaption = 'ميزات من التصميم تُضاف لاحقًا.';
  static const soonPolls = 'الاستطلاعات';
  static const soonRecording = 'تسجيل الجلسة';
  static const soonRecordingWatch = 'مشاهدة التسجيل';
  static const soonScheduled = 'الجلسات المجدولة';

  // ── Immersive room chrome (reference composition) ───────────────────────
  // Bottom control dock, bottom tab bar, participants sheet, mini-player and
  // state cards. Real controls keep their own labels/keys above; these are the
  // dock/tab labels and the locked-placeholder wording for unbacked features.
  static const dockCamera = 'الكاميرا';
  static const dockMic = 'الميكروفون';
  static const dockScreen = 'مشاركة الشاشة';
  static const dockLeave = 'مغادرة';
  static const dockJoin = 'انضمام';
  static const dockReact = 'تفاعل';

  // ── The room's four reactions (ADR 0049) ───────────────────────────────
  // Ephemeral gestures for the session's participants: drawn over the stage
  // as they happen, naming nobody, kept nowhere.
  static const reactionsLabel = 'تفاعلات البث';
  static const reactionsForParticipants = 'التفاعل متاح للمشاركين في البث.';
  static String reactionLabel(LiveReactionKind kind) => switch (kind) {
    LiveReactionKind.heart => 'قلب',
    LiveReactionKind.thumbsUp => 'أعجبني',
    LiveReactionKind.clap => 'تصفيق',
    LiveReactionKind.smile => 'ابتسامة',
  };
  static const dockMore = 'المزيد';

  static const tabParticipants = 'المشاركون';
  static const tabChat = 'دردشة البث';
  static const tabPolls = 'الاستطلاعات';
  static const tabSettings = 'الإعدادات';

  /// The broadcast's own chat (ADR 0047) — separate from the community's group
  /// conversation, which stays one tap away ([chatGroupOpen]).
  static const chatTitle = 'دردشة البث';
  static const chatHint = 'دردشة خاصة بهذا البث، منفصلة عن محادثة الكروب.';
  static const chatEmpty = 'لا رسائل بعد. اكتب أول سؤال أو تعليق.';
  static const chatFieldHint = 'اكتب رسالة للبث…';
  static const chatSend = 'إرسال';
  static const chatLockedForMe =
      'أغلق المشرف الدردشة مؤقتًا؛ يكتب المشرفون فقط الآن.';
  static const chatLockedForModerator =
      'الدردشة مغلقة أمام المشاركين؛ ما زال بإمكانك الكتابة.';
  static const chatEnded = 'انتهى البث؛ الدردشة للقراءة فقط.';
  static const chatLock = 'إغلاق الدردشة';
  static const chatUnlock = 'فتح الدردشة';
  static const chatLockedDone = 'أُغلقت الدردشة أمام المشاركين';
  static const chatUnlockedDone = 'فُتحت الدردشة للجميع';
  static const chatLoadOlder = 'رسائل أقدم';
  static const chatLoadFailed = 'تعذّر تحميل دردشة البث.';

  /// The community's EXISTING group conversation, still reachable from the
  /// broadcast via the access-checked `CommunityChatOpener` — a different place.
  static const chatGroupTitle = 'محادثة الكروب';
  static const chatGroupOpen = 'فتح محادثة الكروب';
  static const chatGroupHint =
      'محادثة الكروب منفصلة عن دردشة البث وتبقى بعد انتهائه.';

  /// Shown when a locked («غير متاح الآن») control is tapped — visible,
  /// actionable text confirming it is intentionally unavailable, not broken.
  static String lockedTapped(String label) => '$label: $soonBadge';

  /// The participants sheet (reference: المشاركون), its search, and the roster
  /// sections. Listeners have no names in this build, so that section is a
  /// locked placeholder — never fabricated rows.
  static const participantsTitle = 'المشاركون';
  static const participantsSearch = 'ابحث عن مشارك';
  static const sectionSpeakers = 'المتحدثون';
  static const sectionListeners = 'المستمعون';
  static const listenersUnavailable = 'قائمة المستمعين غير متاحة بعد.';
  static const roleHost = 'المضيف';
  static const chatUnavailable = 'الدردشة أثناء البث غير متاحة بعد.';

  // ── Live presence (who is actually connected, from LiveKit) ─────────────
  // The connected roster comes from LiveKit (every token carries a display
  // name; no one is hidden). A COUNT is shown to everyone; NAMES are shown to
  // moderators only — the app-level policy on exposing a named presence roster
  // to listeners is deferred (Q68, backend `contracts/presence.ts`), so this
  // stays conservative until the owner decides. Never a fabricated number.
  static const presenceTitle = 'المشاركون المتصلون';
  static String presenceCount(int n) => 'المتصلون الآن: $n';
  static const presenceEmpty = 'لا يوجد مشاركون متصلون الآن.';
  static const presenceJoinToSee =
      'انضم إلى صوت الجلسة لعرض المشاركين المتصلين.';
  static const presenceNamesModerators = 'أسماء المشاركين متاحة للمشرفين.';
  static const youLabel = 'أنت';
  static const roleListener = 'مستمع';
  static const roleSpeaker = 'متحدّث';
  static const roleModerator = 'مشرف';

  /// The chat composer shown in the reference listener view — not backed.
  static const composerHint = 'اكتب رسالة…';

  /// A scheduled broadcast (reference state card) — no scheduling model exists,
  /// so it is a locked placeholder.
  static const scheduledTitle = 'بث مجدول';
  static const scheduledRemind = 'تذكيري';

  /// The mini-player (reference) — continuing audio while browsing is not
  /// supported (the session is screen-scoped), so it is a locked placeholder.
  static const miniPlayerTitle = 'مشغّل مصغّر';
  static const miniPlayerBody = 'متابعة البث أثناء التصفّح غير متاحة بعد.';

  static String error(String? code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'live.community_not_found' ||
    'live.session_not_found' => 'هذه الجلسة غير متاحة لك.',
    'communities.capability_required' ||
    'identity.permission_denied' ||
    'live.not_a_moderator' => 'هذا غير متاح لك في هذا المجتمع.',
    'live.chat_locked' => chatLockedForMe,
    'live.session_not_live' => chatEnded,
    'live.chat_body_required' => 'اكتب نصًّا للرسالة.',
    'live.chat_body_too_long' => 'الرسالة أطول من المسموح به (500 حرف).',
    'live.too_many_chat_messages' => 'أرسلت رسائل كثيرة متتابعة. انتظر قليلًا.',
    'live.unreadable' =>
      'وصلت من الخادم بيانات لا يقرؤها هذا الإصدار من التطبيق.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر عرض الجلسة المباشرة.',
  };
}
