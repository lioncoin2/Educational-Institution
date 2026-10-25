import 'package:flutter/material.dart';

import '../../data/models/communities.dart' show CommunityKind;
import '../../data/models/messaging.dart';

/// What the messaging screens say, in one place: the server speaks in stable
/// codes, the person reads Arabic sentences.
abstract final class MessagingCopy {
  static String error(String? code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'messaging.posting_not_allowed' => 'النشر في هذه القناة لمشرفيها فقط.',
    'messaging.too_many_messages' => 'أرسلت رسائل كثيرة متتابعة. انتظر قليلًا.',
    'messaging.body_too_long' => 'الرسالة أطول من المسموح به.',
    'messaging.conversation_not_found' => 'هذه المحادثة غير متاحة لك.',
    'messaging.attachment_not_found' ||
    'messaging.attachment_unavailable' => 'المرفق غير متاح.',
    'messaging.attachment_kind_invalid' =>
      'لا يمكن إرسال هذا النوع من الملفات هنا.',
    'files.too_large' => 'الملف أكبر من الحجم المسموح به.',
    'files.content_type_not_allowed' ||
    'files.extension_mismatch' => 'نوع الملف غير مسموح به.',
    'files.content_mismatch' => 'محتوى الملف لا يطابق نوعه.',
    'files.too_many_uploads' => 'رفعت ملفات كثيرة. حاول لاحقًا.',
    'messaging.community_chat_over_capacity' =>
      'النشر في هذه المحادثة غير متاح حاليًا لكثرة أعضائها.',
    'messaging.too_many_community_chat_lookups' =>
      'طلبات كثيرة متتابعة. حاول بعد قليل.',
    'messaging.members_hidden' => 'قائمة المشاركين في هذه المحادثة غير معروضة.',
    'messaging.membership_managed_by_community' =>
      'العضوية في هذه المحادثة تتبع العضوية في المجتمع.',
    'messaging.message_moderation_forbidden' =>
      'إدارة رسائل هذه المحادثة ليست من صلاحياتك.',
    'messaging.message_not_found' ||
    'messaging.deleted_message_not_found' => 'لم يُعثر على هذه الرسالة.',
    'messaging.deleted_message_review_expired' =>
      'انتهت مهلة مراجعة الرسالة المحذوفة.',
    'messaging.message_deleted' => 'حُذفت هذه الرسالة فلم يعد تعديلها ممكنًا.',
    'messaging.body_required' => 'اكتب نصًّا للرسالة.',
    _ => 'تعذّر إتمام العملية. حاول مرة أخرى.',
  };

  // ── Moderation (community chat only, ADR 0029) ──────────────────────────
  // A moderator may delete a community-chat message (a tombstone) and review
  // its original for seven days. Shown only when the community's `me` grants
  // `community.messages.moderate`.
  static const moderateDelete = 'حذف الرسالة';
  static const moderateDeleteTitle = 'حذف هذه الرسالة؟';
  static const moderateDeleteBody =
      'ستظهر للجميع كرسالة محذوفة، ويمكن لمشرف مراجعة أصلها خلال سبعة أيام.';
  static const moderateDeleteConfirm = 'حذف';
  static const moderateCancel = 'إلغاء';
  static const moderateDeleteDone = 'تم حذف الرسالة.';
  static const reviewOriginal = 'عرض الرسالة الأصلية';
  static const reviewTitle = 'الرسالة الأصلية';
  static const reviewNoText = '(لا يوجد نص)';
  static const reviewClose = 'إغلاق';

  /// Who deleted the message — the directory's name, or a neutral word, never
  /// an account id.
  static String reviewDeletedBy(String? name) => 'حذفها: ${name ?? 'مشرف'}';

  static String reviewAttachments(int count) => 'المرفقات: $count';

  /// A community's chat the viewer may read but not post in — for a reason
  /// the server keeps to itself (locked, no capability, too large).
  static const cannotPostHere = 'لا يمكنك النشر في هذه المحادثة حاليًا.';

  /// A channel (Phase 5): the viewer reads, only the owner and the delegated
  /// publishers post.
  static const channelReadOnly = 'هذه قناة: ينشر فيها المالك والناشرون فقط، ويمكنك القراءة.';

  /// A group whose posting has been restricted (Phase 5): membership and read
  /// access are unchanged; only posting is limited to the group's moderators.
  static const groupRestrictedReadOnly =
      'الكتابة في هذا الكروب مقيّدة بالمشرفين حاليًا، ويمكنك القراءة.';

  // ── Conversation mute (Q6 / ADR 0036): silence PUSH for one conversation ──
  // In-app and realtime delivery are unchanged; only push is held.
  static const mute = 'كتم الإشعارات';
  static const unmute = 'إلغاء كتم الإشعارات';
  static const muted = 'تم كتم إشعارات هذه المحادثة.';
  static const unmuted = 'أُلغي كتم الإشعارات.';
  static const muteToggleFailed = 'تعذّر تحديث الكتم. حاول مرة أخرى.';

  // ── Starting a direct conversation (Q6, owner GROUP A ruling) ────────────
  // Offered on a co-member's name in a group or community chat, to a viewer
  // whose account may start one. The server decides who they may reach.
  static const startDm = 'بدء محادثة خاصة';

  /// "Message {name}" — the title of the sheet offering to start a DM.
  static String messagePerson(String name) => 'مراسلة $name';

  /// Why a direct conversation could not be started — the server's code, said
  /// plainly. A counterpart the viewer may not reach is told the same as an
  /// unknown account, so nothing is revealed about who is staff.
  static String dmUnavailable(String? code) => switch (code) {
    'messaging.participant_not_eligible' =>
      'لا يمكنك بدء محادثة خاصة مع هذا الشخص.',
    'messaging.direct_with_self' => 'لا يمكنك مراسلة نفسك.',
    'messaging.too_many_conversations' =>
      'بدأت محادثات كثيرة متتابعة. حاول بعد قليل.',
    _ => error(code),
  };

  // ── The teacher directory (Q6): a student finds a teacher to message ────────
  static const messageTeacherTooltip = 'مراسلة معلّم';
  static const messageTeacherTitle = 'مراسلة معلّم';
  static const messageTeacherHint = 'ابحث باسم المعلّم';
  static const messageTeacherPrompt = 'اكتب اسم المعلّم للبحث عنه.';
  static const messageTeacherNoResults = 'لا يوجد معلّم بهذا الاسم.';

  /// The directory answers a page at a time: the next one, on request.
  static const messageTeacherMore = 'عرض المزيد';
  static const messageTeacherMoreFailed = 'تعذّر تحميل المزيد — إعادة المحاولة';

  /// A failure of the teacher search itself (not of starting a conversation):
  /// a refusal (the account may not use the directory) or an unreadable answer.
  static String teacherSearchError(String? code) => switch (code) {
    'identity.permission_denied' => 'لا تملك صلاحية البحث عن المعلّمين.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    // 503 from the server: a transient outage, not "no teachers" — the viewer
    // may retry (editing the search re-asks).
    'unavailable' => 'الخدمة غير متاحة مؤقتًا. حاول مرة أخرى بعد قليل.',
    _ => 'تعذّر البحث. حاول مرة أخرى.',
  };

  static String typeLabel(ConversationType type, int memberCount) =>
      switch (type) {
        ConversationType.direct => 'محادثة خاصة',
        ConversationType.group => 'مجموعة · $memberCount أعضاء',
        ConversationType.channel => 'قناة · $memberCount مشتركًا',
        ConversationType.unknown => 'محادثة',
      };

  /// A community chat's header label from the community's product kind, not its
  /// transport type (every community chat is carried as a CHANNEL, Q51): a
  /// group reads as "group", a real channel as "channel".
  static String communityTypeLabel(CommunityKind kind, int memberCount) =>
      switch (kind) {
        CommunityKind.group => 'مجموعة · $memberCount عضوًا',
        CommunityKind.channel => 'قناة · $memberCount مشتركًا',
      };

  /// The conversation header's subtitle. For a community chat whose kind the
  /// server reported, it names the product kind (group vs channel); otherwise
  /// it falls back to the transport [typeLabel] — so a genuine channel, and a
  /// community chat whose kind is unknown, are never mislabelled as a group.
  static String conversationSubtitle(Conversation conversation) =>
      conversation.isCommunityChat && conversation.communityKind != null
      ? communityTypeLabel(conversation.communityKind!, conversation.memberCount)
      : typeLabel(conversation.type, conversation.memberCount);

  /// The fallback title before a conversation has loaded.
  static const String conversationFallbackTitle = 'محادثة';

  /// Tapping a community chat's header opens the community's info & management.
  static const String communityInfo = 'معلومات الكروب وإدارته';

  // ── Live session indicator (Phase 3) ───────────────────────────────────
  // Shown under the app bar only while the server says a session is live for
  // THIS community. It states that a session is running — never that audio or
  // video is working (the media may be a fake provider); the live screen is
  // the one place that reports whether joining is available.
  static const String liveNow = 'بث مباشر الآن';
  static const String liveNowHint = 'اضغط لعرض الجلسة';
  static const String liveNowSemantics = 'بث مباشر في هذا الكروب — اضغط لعرض الجلسة';

  /// The reader themself, as the author of a quoted message in a reply.
  static const String you = 'أنت';

  /// The quoted message in a reply is not in the loaded window (or was removed):
  /// the reference is kept, its content truthfully reported as unavailable
  /// rather than invented.
  static const String quoteUnavailable = 'الرسالة الأصلية غير متاحة';

  /// The reply action on a message, and the composer banner while replying.
  static const String reply = 'رد';
  static const String replyingTitle = 'الرد على رسالة';
  static String replyingTo(String name) => 'الرد على $name';
  static const String cancelReply = 'إلغاء الرد';

  // ── The author's own message (ADR 0045) ────────────────────────────────
  static const String edit = 'تعديل الرسالة';
  static const String editCaption = 'تعديل التعليق';
  static const String editTitle = 'تعديل الرسالة';
  static const String editSave = 'حفظ';
  static const String editCancel = 'إلغاء';
  static const String editDone = 'عُدّلت الرسالة';
  static const String edited = 'معدّلة';
  static const String deleteOwn = 'حذف الرسالة';
  static const String deleteOwnTitle = 'حذف هذه الرسالة؟';
  static const String deleteOwnBody =
      'ستظهر للجميع بأنها «محذوفة»، ولا يمكن التراجع عن ذلك.';
  static const String deleteOwnConfirm = 'حذف';
  static const String deleteOwnDone = 'حُذفت الرسالة';

  // ── Pinned messages (ADR 0043) ─────────────────────────────────────────
  static const String pin = 'تثبيت الرسالة';
  static const String unpin = 'إلغاء التثبيت';
  static const String pinnedTitle = 'رسالة مثبتة';
  static const String unpinTooltip = 'إلغاء التثبيت';
  static const String pinnedUnavailable = 'الرسالة المثبتة غير متاحة';
  static const String pinDone = 'تم تثبيت الرسالة';
  static const String unpinDone = 'تم إلغاء التثبيت';
  static const String pinLoading = 'جارٍ تحميل الرسالة المثبتة…';

  /// A one-line quote of the message a reply points to: its text, or a truthful
  /// label for a media message — a document's real filename, an image label, or
  /// a voice label with its duration when the data carries one. Reads only what
  /// the loaded [Message] holds; nothing is invented.
  static String quotePreview(Message message) {
    if (message.isDeleted) return 'رسالة محذوفة';
    final attachment = message.attachments.firstOrNull;
    final kind = switch (message.type) {
      MessageType.voice => attachment?.durationMs != null
          ? 'رسالة صوتية · ${duration(attachment!.durationMs)}'
          : 'رسالة صوتية',
      MessageType.image => 'صورة',
      MessageType.file => attachment?.displayName ?? 'ملف',
      MessageType.unknown => 'رسالة',
      MessageType.text => null,
    };
    final text = message.body?.trim();
    if (kind == null) return text ?? '';
    return text == null || text.isEmpty ? kind : '$kind: $text';
  }

  /// A list preview: the text, or what kind of message it was.
  static String preview(MessagePreview? message) {
    if (message == null) return 'لا توجد رسائل بعد';
    if (message.deleted) return 'رسالة محذوفة';
    final text = message.text;
    final kind = switch (message.type) {
      MessageType.voice => 'رسالة صوتية',
      MessageType.image => 'صورة',
      MessageType.file => 'ملف',
      MessageType.unknown => 'رسالة',
      MessageType.text => null,
    };
    if (kind == null) return text ?? '';
    return text == null || text.isEmpty ? kind : '$kind: $text';
  }

  static String unreadBadge(int count) =>
      count >= Conversation.unreadCountCap ? '99+' : '$count';

  static String duration(int? milliseconds) {
    if (milliseconds == null) return '';
    final seconds = (milliseconds / 1000).round();
    return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
  }

  static String size(int? bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return '$bytes بايت';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} ك.ب';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} م.ب';
  }

  static String time(BuildContext context, DateTime at) {
    final local = at.toLocal();
    final now = DateTime.now();
    final localizations = MaterialLocalizations.of(context);
    final sameDay =
        local.year == now.year &&
        local.month == now.month &&
        local.day == now.day;
    return sameDay
        ? localizations.formatTimeOfDay(TimeOfDay.fromDateTime(local))
        : localizations.formatShortMonthDay(local);
  }

  static String clock(BuildContext context, DateTime at) =>
      MaterialLocalizations.of(context)
          .formatTimeOfDay(TimeOfDay.fromDateTime(at.toLocal()));
}
