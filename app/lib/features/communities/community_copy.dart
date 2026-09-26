import 'package:flutter/material.dart';

import '../../data/models/communities.dart';

/// What the community screens say, in one place: the server speaks in stable
/// codes and enum values, the person reads Arabic sentences.
///
/// Nothing here states a rule the server did not send. A lock is said to be
/// on — never what it closes, which is the server's provisional table and
/// shows only as the actions the server still offers. A refusal is said
/// without its reason: never why someone cannot be removed or handed the
/// community, who may leave, or what a lock or a link's end means for
/// anyone. No account id, email or token is ever put in a sentence here —
/// the one link a person is shown is the new link itself, once.
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

  // ── Managing a community ──

  static const managementTitle = 'إدارة المجتمع';
  static const invitationLinks = 'روابط الدعوة';
  static const lock = 'قفل المجتمع';
  static const unlock = 'فتح المجتمع';
  static const leave = 'مغادرة المجتمع';

  /// Declines a question — never "إلغاء", which also names revoking a link.
  static const cancel = 'تراجع';
  static const confirmLock = 'قفل';
  static const confirmLeave = 'مغادرة';

  static String lockQuestion(Community community) =>
      'قفل «${community.title}»؟';

  static String leaveQuestion(Community community) =>
      'مغادرة «${community.title}»؟';

  /// Why a change did not go through, by the server's code — said without
  /// its reason.
  static String writeFailed(String code) => switch (code) {
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'identity.authentication_required' => 'انتهت الجلسة. سجّل الدخول من جديد.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    final c when c.startsWith('communities.too_many_') =>
      'طلبات كثيرة متتابعة. حاول بعد قليل.',
    'communities.conflict' || 'communities.owner_conflict' =>
      'تغيّر شيء في المجتمع في اللحظة نفسها، فلم يتمّ الطلب. حاول مرة أخرى.',
    'communities.community_not_found' => gone,
    'communities.member_not_found' => 'هذا الشخص ليس عضوًا في المجتمع الآن.',
    'communities.invitation_not_found' => 'لم يُعثر على رابط الدعوة هذا.',
    'communities.grant_not_found' => 'لم يُعثر على هذه الصلاحية.',
    'communities.owner_not_removable' ||
    'communities.cannot_remove_self' ||
    'communities.member_holds_more_capabilities' ||
    'communities.owner_ineligible' ||
    'communities.owner_self_assignment' ||
    'communities.grantee_ineligible' => 'تعذّر ذلك مع هذا العضو.',
    'communities.owner_cannot_leave' => 'تعذّرت مغادرة المجتمع.',
    'communities.community_locked' => 'هذا غير متاح في المجتمع الآن.',
    'communities.capability_required' ||
    'identity.permission_denied' ||
    'communities.not_community_owner' => 'هذا غير متاح لك في هذا المجتمع.',
    'communities.unreadable' =>
      'وصلت من الخادم بيانات لا يقرؤها هذا الإصدار من التطبيق.',
    _ => 'تعذّر إتمام الطلب. حاول مرة أخرى.',
  };

  // ── The roster's actions ──

  /// A member as the screens name them: their name, or the neutral word.
  static String memberName(CommunityMember member) =>
      member.displayName ?? unnamedMember;

  /// The tooltip — and the spoken label — of a row's actions button.
  static String memberOptions(CommunityMember member) =>
      'خيارات ${memberName(member)}';

  static const memberCapabilities = 'الصلاحيات';
  static const makeOwner = 'نقل ملكية المجتمع';
  static const removeMember = 'إزالة من المجتمع';
  static const confirmRemove = 'إزالة';
  static const confirmTransfer = 'نقل الملكية';
  static const ownershipTransferred = 'نُقلت ملكية المجتمع.';

  static String removeQuestion(CommunityMember member) =>
      'إزالة ${memberName(member)} من المجتمع؟';

  static String transferQuestion(CommunityMember member) =>
      'نقل ملكية المجتمع إلى ${memberName(member)}؟';

  // ── A member's capabilities ──

  static String capabilitiesOf(CommunityMember member) =>
      'صلاحيات ${memberName(member)}';

  static const granted = 'ممنوحة';

  /// Granted, but not in effect now — why, the server does not say.
  static const grantedDormant = 'ممنوحة، وغير سارية الآن';
  static const notGranted = 'غير ممنوحة';
  static const revokeGrant = 'سحب';
  static const grantChosen = 'منح المحدّد';
  static const grantsHint = 'حدّد ما تريد منحه، ثم اضغط «منح المحدّد».';

  /// Also what the sheet says once the server no longer lets the viewer
  /// manage grants.
  static const notYours = 'هذا غير متاح لك في هذا المجتمع.';

  static String revokeGrantTooltip(CommunityCapability c) =>
      'سحب «${capability(c)}»';

  static String grantStatus(CommunityGrant? grant) => grant == null
      ? notGranted
      : grant.dormant
      ? grantedDormant
      : granted;

  // ── Invitation links ──

  static const createLink = 'إنشاء رابط دعوة';
  static const linksOnWeb = 'تُنشأ روابط الدعوة من نسخة الويب من التطبيق.';
  static const invitationsEmpty = 'لا توجد روابط دعوة بعد.';
  static const invitationsForbidden =
      'روابط الدعوة في هذا المجتمع غير متاحة لك.';
  static const demoInvitations = 'روابط تجريبية للعرض فقط.';
  static const createdByYou = 'أنشأته أنت';
  static const revokeLink = 'إلغاء الرابط';
  static const revokeLinkQuestion = 'إلغاء رابط الدعوة هذا؟';

  /// A link was made, and this build has no address to write it at.
  static const linkNotShown =
      'أُنشئ الرابط، لكن تعذّر عرضه هنا. يمكنك إلغاؤه من القائمة.';

  /// The server's state of a link, as it says it — ACTIVE promises nothing
  /// more than that.
  static String invitationState(InvitationState state) => switch (state) {
    InvitationState.active => 'نشط',
    InvitationState.expired => 'منتهي الصلاحية',
    InvitationState.exhausted => 'مستنفد',
    InvitationState.revoked => 'ملغى',
    InvitationState.unknown => 'حالة غير معروفة',
  };

  static String expiry(BuildContext context, DateTime at) =>
      'تاريخ الانتهاء: ${date(context, at)}';

  static String uses(CommunityInvitation invitation) =>
      invitation.maxUses == null
      ? 'مرات الاستخدام: ${invitation.uses}'
      : 'مرات الاستخدام: ${invitation.uses} من ${invitation.maxUses}';

  static String invitationLabel(
    BuildContext context,
    CommunityInvitation invitation, {
    required bool mine,
  }) => [
    invitationState(invitation.state),
    expiry(context, invitation.expiresAt),
    uses(invitation),
    if (mine) createdByYou,
  ].join('، ');

  // ── A new link, shown once ──

  static const linkSheetTitle = 'رابط الدعوة';
  static const linkSheetNote =
      'يظهر هذا الرابط هذه المرة فقط. انسخه الآن وأرسله إلى من تدعوه.';
  static const copyLink = 'نسخ الرابط';
  static const linkCopied = 'نُسخ الرابط';
  static const copyFailed = 'تعذّر النسخ. حدّد الرابط وانسخه يدويًا.';
  static const done = 'تم';

  // ── Opening an invitation ──

  static const inviteTitle = 'دعوة إلى مجتمع';
  static const noInvitation = 'لا توجد دعوة لفتحها.';
  static const invited = 'لقد دُعيت إلى مجتمع.';
  static const join = 'انضمام';
  static const signInToJoin = 'سجّل الدخول لقبول الدعوة';
  static const inTheCommunity = 'أنت الآن في المجتمع.';

  /// Not "فتح المجتمع", which is unlocking it.
  static const toCommunity = 'الذهاب إلى المجتمع';
  static const toCommunities = 'الذهاب إلى مجتمعاتي';

  /// Why a link did not admit the viewer. [code] null: what was given had no
  /// token's shape, and was never sent.
  static String joinFailed(String? code) => switch (code) {
    null || 'communities.invitation_invalid' => 'رابط الدعوة هذا غير صالح.',
    'communities.invitation_expired' => 'انتهت صلاحية رابط الدعوة هذا.',
    'communities.invitation_revoked' => 'أُلغي رابط الدعوة هذا.',
    'communities.invitation_exhausted' => 'بلغ رابط الدعوة هذا حدّ استخدامه.',
    'communities.rejoin_requires_manager' ||
    'communities.community_locked' => 'تعذّر الانضمام بهذا الرابط.',
    'network.unreachable' => 'تعذّر الاتصال بالخادم. تحقّق من الاتصال.',
    'unavailable' => 'الخدمة غير متاحة الآن. حاول بعد قليل.',
    final String c when c.startsWith('communities.too_many_') =>
      'محاولات كثيرة متتابعة. حاول بعد قليل.',
    'communities.conflict' => 'لم يكتمل الطلب. حاول مرة أخرى.',
    'communities.unreadable' =>
      'وصلت من الخادم بيانات لا يقرؤها هذا الإصدار من التطبيق.',
    _ => 'تعذّر الانضمام الآن. حاول مرة أخرى.',
  };
}
