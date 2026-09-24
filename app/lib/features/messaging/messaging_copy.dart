import 'package:flutter/material.dart';

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
    _ => 'تعذّر إتمام العملية. حاول مرة أخرى.',
  };

  /// A community's chat the viewer may read but not post in — for a reason
  /// the server keeps to itself (locked, no capability, too large).
  static const cannotPostHere = 'لا يمكنك النشر في هذه المحادثة حاليًا.';

  static String typeLabel(ConversationType type, int memberCount) =>
      switch (type) {
        ConversationType.direct => 'محادثة خاصة',
        ConversationType.group => 'مجموعة · $memberCount أعضاء',
        ConversationType.channel => 'قناة · $memberCount مشتركًا',
        ConversationType.unknown => 'محادثة',
      };

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
