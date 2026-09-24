import 'package:flutter/material.dart';

import '../../data/models/communities.dart';

/// What the community screens say, in one place: the server speaks in stable
/// codes and enum values, the person reads Arabic sentences.
///
/// Nothing here states a rule the server did not send. A lock is said to be
/// on — never what it closes, which is the server's provisional table and
/// shows only as the actions the server still offers.
abstract final class CommunityCopy {
  static const screenTitle = 'مجتمعاتي';
  static const detailTitle = 'المجتمع';
  static const membersTitle = 'أعضاء المجتمع';
  static const refresh = 'تحديث';
  static const retry = 'إعادة المحاولة';
  static const loadMore = 'عرض المزيد';
  static const loadMoreFailed = 'تعذّر التحميل — إعادة المحاولة';

  static const signInTitle = 'سجّل الدخول لعرض مجتمعاتك';

  static const empty = 'لست عضوًا في أي مجتمع بعد';
  static const emptyMessage = 'تظهر هنا المجتمعات التي تنضمّ إليها في المعهد.';
  static const demoBanner =
      'مجتمعات تجريبية للعرض فقط. عند ربط التطبيق بالخادم تظهر مجتمعاتك '
      'الحقيقية هنا.';
  static const demoCommunity = 'مجتمع تجريبي للعرض فقط.';
  static const demoMembers = 'أعضاء تجريبيون للعرض فقط.';

  static const locked = 'مقفل';
  static const lockedNotice = 'هذا المجتمع مقفل حاليًا.';

  static const membership = 'عضويتي';
  static const standingLabel = 'صفتك في المجتمع';
  static const joinedLabel = 'تاريخ الانضمام';
  static const capabilitiesTitle = 'صلاحياتي';
  static const delegated = 'مفوَّضة';

  static const openChat = 'فتح محادثة المجتمع';
  static const viewMembers = 'عرض الأعضاء';

  /// The viewer was in it, and no longer is.
  static const removed = 'لم تعد عضوًا في هذا المجتمع.';

  /// Nothing to show from the start: the server answers "no such community"
  /// alike for one that does not exist and one that is not the viewer's.
  static const gone = 'هذا المجتمع غير متاح لك.';
  static const backToList = 'العودة إلى مجتمعاتي';

  static const membersEmpty = 'لا يوجد أعضاء لعرضهم.';
  static const membersForbidden = 'عرض أعضاء هذا المجتمع غير متاح لك.';

  /// A member the directory has no name for — never their id or email.
  static const unnamedMember = 'عضو';
  static const inactiveAccount = 'حساب غير نشط';

  static String error(String? code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'communities.community_not_found' => gone,
    'communities.capability_required' ||
    'identity.permission_denied' => 'هذا غير متاح لك في هذا المجتمع.',
    'communities.cursor_invalid' =>
      'تعذّر متابعة القائمة. حدّثها وحاول مرة أخرى.',
    'communities.unreadable' =>
      'وصلت من الخادم بيانات لا يقرؤها هذا الإصدار من التطبيق.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    _ => 'تعذّر عرض المحتوى. حاول مرة أخرى.',
  };

  /// Why the community's chat did not open — messaging's codes.
  static String chatUnavailable(String? code) => switch (code) {
    'messaging.conversation_not_found' => 'محادثة هذا المجتمع غير متاحة لك.',
    'messaging.too_many_community_chat_lookups' =>
      'طلبات كثيرة متتابعة. حاول بعد قليل.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    _ => 'تعذّر فتح المحادثة الآن. حاول لاحقًا.',
  };

  /// "N members", with the number agreeing as Arabic needs it to.
  static String members(int count) {
    if (count <= 0) return 'لا أعضاء بعد';
    if (count == 1) return 'عضو واحد';
    if (count == 2) return 'عضوان';
    final tail = count % 100;
    if (tail >= 3 && tail <= 10) return '$count أعضاء';
    if (tail >= 11) return '$count عضوًا';
    return '$count عضو';
  }

  static String standing(CommunityMe me) => switch (me.standing) {
    null => 'اطّلاع إشرافي',
    CommunityStanding.owner => 'مالك المجتمع',
    CommunityStanding.member => 'عضو',
    CommunityStanding.unknown => 'عضوية غير معروفة',
  };

  static String capability(CommunityCapability capability) =>
      switch (capability) {
        CommunityCapability.membersView => 'الاطّلاع على قائمة الأعضاء',
        CommunityCapability.membersInvite => 'دعوة أعضاء',
        CommunityCapability.membersRemove => 'إزالة أعضاء',
        CommunityCapability.lock => 'قفل المجتمع وفتحه',
        CommunityCapability.chatPost => 'النشر في المحادثة',
        CommunityCapability.liveStart => 'بدء جلسة مباشرة',
        CommunityCapability.liveModerate => 'إدارة الجلسات المباشرة',
        CommunityCapability.unknown => 'صلاحية',
      };

  /// A member's capabilities are theirs by delegation from the owner.
  static String delegatedCapability(CommunityCapability capability) =>
      '${CommunityCopy.capability(capability)} · $delegated';

  static String date(BuildContext context, DateTime at) =>
      MaterialLocalizations.of(context).formatMediumDate(at.toLocal());

  static String joined(BuildContext context, DateTime at) =>
      'انضمّ في ${date(context, at)}';

  static String memberLabel(CommunityMember member) => [
    member.displayName ?? unnamedMember,
    if (!member.active) inactiveAccount,
  ].join('، ');

  static String communityLabel(Community community) => [
    community.title,
    members(community.memberCount),
    if (community.isLocked) locked,
  ].join('، ');
}
