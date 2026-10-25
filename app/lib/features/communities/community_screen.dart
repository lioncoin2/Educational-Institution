import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/theme/messaging_palette.dart';
import '../../core/widgets/foundations/app_avatar.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/foundations/stat_badge.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/patterns/info_row.dart';
import '../../data/models/academic.dart';
import '../../data/models/communities.dart';
import '../../data/models/live.dart';
import '../../providers/app_providers.dart';
import '../messaging/widgets/connection_banner.dart';
import 'community_copy.dart';
import 'state/community_chat_opener.dart';
import 'state/community_controller.dart';
import 'state/community_write.dart';
import 'widgets/community_change.dart';
import 'widgets/add_member_sheet.dart';
import 'widgets/community_states.dart';
import 'widgets/edit_community_profile_sheet.dart';
import 'widgets/halaqa_picker.dart';

/// One community, as the viewer may see it now: whether it is locked, how
/// many are in it, where the viewer stands, and what the server says they
/// may do — every action shown if and only if the server's answer holds it.
///
/// A locked community says it is locked and nothing more: what a lock closes
/// is the server's to decide, and shows only as the actions still offered.
///
/// What the viewer may change about the community — its links, its lock,
/// their own membership — is a section of its own, there only when the
/// server offers at least one of them.
class CommunityScreen extends ConsumerWidget {
  const CommunityScreen({super.key, required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = communityProvider(communityId);
    final value = ref.watch(provider);
    final community = value.value?.community;
    // Shares the messaging design system's green/cream palette.
    final screen = AppScreen(
      title: community?.title ?? CommunityCopy.detailTitle,
      actions: [
        IconButton(
          tooltip: CommunityCopy.refresh,
          // Reads again under what is shown; never starts the screen over.
          onPressed: () => ref.read(provider.notifier).refresh(),
          icon: const Icon(Icons.refresh_rounded),
        ),
        const SizedBox(width: Insets.sm),
      ],
      slivers: [
        const SliverToBoxAdapter(child: ConnectionBanner()),
        SliverGutter(
          top: Insets.lg,
          child: AsyncView(
            value: value,
            loading: const CommunitySkeleton(rows: 3, height: 120),
            errorBuilder: (context, error) => CommunityErrorView(
              error: error,
              onRetry: () => ref.invalidate(provider),
            ),
            builder: (context, state) => state.removed
                ? CommunityGoneView(wasShown: state.community != null)
                : _Details(community: state.community!, writing: state.writing),
          ),
        ),
      ],
    );
    return Theme(
      data: MessagingPalette.themeOf(context),
      child: screen,
    );
  }
}

class _Details extends ConsumerWidget {
  const _Details({required this.community, required this.writing});

  final Community community;
  final CommunityWrite? writing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = community.me;
    // A delegate who may add members (community.members.invite) but not view
    // the list: the members screen — and the add icon on it — is reached only
    // through «الأعضاء», so this viewer needs its own way in.
    final addOnly =
        me.has(CommunityCapability.membersInvite) && !community.canViewMembers;
    final capabilities = [
      for (final c in CommunityCapability.values)
        if (me.has(c)) c,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (community.origin.isMock) ...[
          const MockBanner(message: CommunityCopy.demoCommunity),
          const SizedBox(height: Insets.lg),
        ],
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AppAvatar(
                    name: community.title,
                    imageUrl: ref
                        .watch(communityAvatarUrlProvider(community.id))
                        .value,
                    radius: 28,
                  ),
                  const SizedBox(width: Insets.md),
                  Expanded(
                    child: Text(
                      community.title,
                      style: context.text.titleLarge,
                    ),
                  ),
                  if (community.canEditProfile)
                    IconButton(
                      tooltip: CommunityCopy.editCommunity,
                      icon: const Icon(Icons.edit_outlined),
                      onPressed: () =>
                          showEditCommunityProfile(context, community),
                    ),
                ],
              ),
              if (community.description case final description?) ...[
                const SizedBox(height: Insets.sm),
                Text(description, style: context.text.bodyMedium),
              ],
              const SizedBox(height: Insets.sm),
              Wrap(
                spacing: Insets.sm,
                runSpacing: Insets.sm,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  StatBadge(
                    label: CommunityCopy.members(community.memberCount),
                    icon: Icons.groups_2_outlined,
                  ),
                  if (community.isLocked)
                    const StatBadge(
                      label: CommunityCopy.locked,
                      icon: Icons.lock_outline_rounded,
                      tone: StatBadgeTone.soft,
                    ),
                  // How posting stands here: a channel, or a group whose
                  // posting has been restricted. An open group says nothing
                  // (posting is its default). Informational only; the server
                  // decides who may post.
                  if (community.isChannel)
                    const StatBadge(
                      key: Key('community-chat-mode'),
                      label: CommunityCopy.chatModeChannel,
                      icon: Icons.campaign_outlined,
                      tone: StatBadgeTone.soft,
                    )
                  else if (community.isRestrictedGroup)
                    const StatBadge(
                      key: Key('community-chat-mode'),
                      label: CommunityCopy.chatModeGroupRestricted,
                      icon: Icons.edit_off_outlined,
                      tone: StatBadgeTone.soft,
                    ),
                ],
              ),
              if (community.isLocked) ...[
                const SizedBox(height: Insets.md),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      Icons.info_outline_rounded,
                      size: 18,
                      color: context.colors.onSurfaceVariant,
                    ),
                    const SizedBox(width: Insets.sm),
                    Expanded(
                      child: Text(
                        CommunityCopy.lockedNotice,
                        style: context.text.bodyMedium,
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: Insets.xxl),
        const SectionHeader(title: CommunityCopy.membership),
        const SizedBox(height: Insets.md),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              InfoRow(
                icon: Icons.badge_outlined,
                label: CommunityCopy.standingLabel,
                value: CommunityCopy.standing(me),
              ),
              if (me.joinedAt case final joinedAt?)
                InfoRow(
                  icon: Icons.event_outlined,
                  label: CommunityCopy.joinedLabel,
                  value: CommunityCopy.date(context, joinedAt),
                ),
            ],
          ),
        ),
        if (capabilities.isNotEmpty) ...[
          const SizedBox(height: Insets.xxl),
          const SectionHeader(title: CommunityCopy.capabilitiesTitle),
          const SizedBox(height: Insets.md),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            children: [
              // Named alike: the answer says what the viewer may do, never
              // on what basis (an owner's grant, oversight, ownership).
              for (final c in capabilities)
                AppPill(
                  label: CommunityCopy.capability(c),
                  dotColor: context.colors.primary,
                ),
            ],
          ),
        ],
        if (community.canOpenChat ||
            community.canViewMembers ||
            addOnly ||
            me.takesPart(CommunityParticipation.liveJoin) ||
            me.has(CommunityCapability.liveStart) ||
            me.has(CommunityCapability.attendanceRecord) ||
            me.has(CommunityCapability.liveModerate) ||
            me.has(CommunityCapability.attendanceView)) ...[
          const SizedBox(height: Insets.xxl),
          const SectionHeader(title: CommunityCopy.actionsTitle),
          const SizedBox(height: Insets.md),
          if (community.canOpenChat) _OpenChatButton(communityId: community.id),
          if (community.canOpenChat &&
              (community.canViewMembers || addOnly))
            const SizedBox(height: Insets.md),
          if (community.canViewMembers)
            OutlinedButton.icon(
              onPressed: () =>
                  context.push(Routes.communityMembers(community.id)),
              icon: const Icon(Icons.people_alt_outlined),
              label: const Text(CommunityCopy.viewMembers),
            ),
          // Adding members straight from here, for the delegate who may add
          // but not view the list (see [addOnly]). The sheet's search and the
          // add itself are re-authorised by the server on
          // community.members.invite.
          if (addOnly)
            OutlinedButton.icon(
              key: const Key('community-add-members'),
              onPressed: () =>
                  showAddMember(context, communityId: community.id),
              icon: const Icon(Icons.person_add_alt_1_outlined),
              label: const Text(CommunityCopy.addMembersButton),
            ),
          // The live-session screen, when the server says the viewer may take
          // part in live here. Navigation only — the screen owns loading the
          // session; this never touches live transport or media.
          if (me.takesPart(CommunityParticipation.liveJoin)) ...[
            if (community.canOpenChat || community.canViewMembers || addOnly)
              const SizedBox(height: Insets.md),
            OutlinedButton.icon(
              onPressed: () => context.push(Routes.communityLive(community.id)),
              icon: const Icon(Icons.podcasts_outlined),
              label: const Text(CommunityCopy.viewLive),
            ),
          ],
          // Start a live session, when the server says the viewer may start one
          // here (community.live.start). On success the live room opens (it
          // reads the now-running session); a refusal is said in words. The one
          // mutating action here — a bodyless start the server re-authorises;
          // it touches no live transport or media.
          if (me.has(CommunityCapability.liveStart)) ...[
            if (community.canOpenChat ||
                community.canViewMembers ||
                addOnly ||
                me.takesPart(CommunityParticipation.liveJoin))
              const SizedBox(height: Insets.md),
            _StartLiveButton(communityId: community.id),
          ],
          // The attendance record screen, when the server says the viewer may
          // record here (the record capability or a session moderator's).
          // Navigation only — that screen consumes the live session and the
          // attendance repository; this entry injects neither.
          if (me.has(CommunityCapability.attendanceRecord) ||
              me.has(CommunityCapability.liveModerate)) ...[
            if (community.canOpenChat ||
                community.canViewMembers ||
                addOnly ||
                me.takesPart(CommunityParticipation.liveJoin) ||
                me.has(CommunityCapability.liveStart))
              const SizedBox(height: Insets.md),
            OutlinedButton.icon(
              onPressed: () =>
                  context.push(Routes.communityAttendance(community.id)),
              icon: const Icon(Icons.fact_check_outlined),
              label: const Text(CommunityCopy.openAttendance),
            ),
          ],
          // The attendance history (the community's snapshots), when the
          // server says the viewer may see it. Navigation only — that screen
          // consumes the attendance repository; this entry injects nothing.
          if (me.has(CommunityCapability.attendanceView)) ...[
            if (community.canOpenChat ||
                community.canViewMembers ||
                addOnly ||
                me.takesPart(CommunityParticipation.liveJoin) ||
                me.has(CommunityCapability.liveStart) ||
                me.has(CommunityCapability.attendanceRecord) ||
                me.has(CommunityCapability.liveModerate))
              const SizedBox(height: Insets.md),
            OutlinedButton.icon(
              onPressed: () => context.push(
                Routes.communityAttendanceSnapshots(community.id),
              ),
              icon: const Icon(Icons.history_rounded),
              label: const Text(CommunityCopy.viewAttendance),
            ),
          ],
        ],
        _Management(community: community, writing: writing),
      ],
    );
  }
}

/// Leaving's icon — Icons.logout_rounded, drawn right to left in this RTL app
/// so its arrow points to the end of the line, the way out (Material marks
/// the logout icon to mirror; Flutter's own does not).
const _leaveIcon = IconData(
  0xf88b,
  fontFamily: 'MaterialIcons',
  matchTextDirection: true,
);

/// What the viewer may change about the community, each shown if and only if
/// the server's `me` holds it — nothing at all when it holds none:
///
///   invitation links  `me.capabilities` ∋ community.members.invite, or
///                     `me.operations` ∋ community.invitations.manage
///   lock / unlock     `me.capabilities` ∋ community.lock, by the status the
///                     server gives (one it does not name offers neither)
///   leave             `me.operations` ∋ community.leave
///
/// One change at a time: while one is on its way every button waits, and
/// the one tapped spins. Locking and leaving are asked first; unlocking is
/// not.
class _Management extends ConsumerWidget {
  const _Management({required this.community, required this.writing});

  final Community community;
  final CommunityWrite? writing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = community.me;
    final links =
        me.has(CommunityCapability.membersInvite) ||
        me.allows(CommunityOperation.invitationsManage);
    final locks = me.has(CommunityCapability.lock);
    final canLock = locks && community.status == CommunityStatus.open;
    final canUnlock = locks && community.status == CommunityStatus.locked;
    final canLeave = me.allows(CommunityOperation.leave);
    final idle = writing == null;
    final buttons = [
      if (links)
        OutlinedButton.icon(
          onPressed: () =>
              context.push(Routes.communityInvitations(community.id)),
          icon: const Icon(Icons.link_rounded),
          label: const Text(CommunityCopy.invitationLinks),
        ),
      if (canLock)
        OutlinedButton.icon(
          onPressed: idle ? () => _lock(context, ref) : null,
          icon: writing == CommunityWrite.lock
              ? const BusyIndicator()
              : const Icon(Icons.lock_outline_rounded),
          label: const Text(CommunityCopy.lock),
        ),
      if (canUnlock)
        OutlinedButton.icon(
          onPressed: idle ? () => _unlock(context, ref) : null,
          icon: writing == CommunityWrite.unlock
              ? const BusyIndicator()
              : const Icon(Icons.lock_open_rounded),
          label: const Text(CommunityCopy.unlock),
        ),
      if (canLeave)
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(
            foregroundColor: context.colors.error,
            side: BorderSide(color: context.colors.error),
          ),
          onPressed: idle ? () => _leave(context, ref) : null,
          icon: writing == CommunityWrite.leave
              ? const BusyIndicator()
              : const Icon(_leaveIcon),
          label: const Text(CommunityCopy.leave),
        ),
    ];
    // The halaqa link is institutional oversight (Q50), offered on the
    // server's `me.canManageHalaqa` alone — never a membership capability.
    final showHalaqa = me.canManageHalaqa;
    // Restrict/restore member posting, offered to a holder of
    // `community.chat.manage`. Only a group toggles — a channel's posting is
    // fixed, so the control never appears for one.
    final showChatMode = community.canManageChat && !community.isChannel;
    if (buttons.isEmpty && !showHalaqa && !showChatMode) {
      return const SizedBox.shrink();
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Insets.xxl),
        const SectionHeader(title: CommunityCopy.managementTitle),
        for (final button in buttons) ...[
          const SizedBox(height: Insets.md),
          button,
        ],
        if (showChatMode) ...[
          const SizedBox(height: Insets.lg),
          _ChatModeManagement(community: community, writing: writing),
        ],
        if (showHalaqa) ...[
          const SizedBox(height: Insets.lg),
          _HalaqaManagement(community: community, writing: writing),
        ],
      ],
    );
  }

  CommunityController _controller(WidgetRef ref) =>
      ref.read(communityProvider(community.id).notifier);

  /// Reads the community again — if its screen is still open: a message
  /// offering this may outlive the screen.
  VoidCallback _refreshOf(BuildContext context) {
    final container = ProviderScope.containerOf(context, listen: false);
    final provider = communityProvider(community.id);
    return () {
      if (container.exists(provider)) {
        unawaited(container.read(provider.notifier).refresh());
      }
    };
  }

  Future<void> _lock(BuildContext context, WidgetRef ref) async {
    final yes = await confirmCommunityChange(
      context,
      question: CommunityCopy.lockQuestion(community),
      confirmLabel: CommunityCopy.confirmLock,
    );
    if (!yes || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final refresh = _refreshOf(context);
    sayWriteOutcome(
      messenger,
      await _controller(ref).lock(),
      refresh: refresh,
      confirmed: true,
    );
  }

  Future<void> _unlock(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    final refresh = _refreshOf(context);
    sayWriteOutcome(
      messenger,
      await _controller(ref).unlock(),
      refresh: refresh,
    );
  }

  /// Done, the viewer goes to their list — which no longer has it — if the
  /// community is still where they are: a late answer never moves someone
  /// who has gone elsewhere.
  Future<void> _leave(BuildContext context, WidgetRef ref) async {
    final yes = await confirmCommunityChange(
      context,
      question: CommunityCopy.leaveQuestion(community),
      confirmLabel: CommunityCopy.confirmLeave,
      destructive: true,
    );
    if (!yes || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    // The route, not this section: once left, the screen says so in its
    // place — the route stays.
    final screen = ModalRoute.of(context);
    final refresh = _refreshOf(context);
    final outcome = await _controller(ref).leave();
    if (outcome is WriteDone && (screen?.isCurrent ?? false)) {
      router.go(Routes.communities);
    }
    sayWriteOutcome(messenger, outcome, refresh: refresh, confirmed: true);
  }
}

/// Restrict or reopen member posting in a group, shown only to a holder of
/// `community.chat.manage` and only for a group (a channel's posting is fixed).
/// The current state is shown in words; restricting keeps every member's
/// membership and read access and only limits who may post, and reopening
/// restores it. One request at a time, like the rest of [_Management], and
/// NOT optimistic — the state and the composer change only once the server's
/// answer is reconciled. The server re-authorises and decides; a refusal is
/// said in words.
class _ChatModeManagement extends ConsumerWidget {
  const _ChatModeManagement({required this.community, required this.writing});

  final Community community;
  final CommunityWrite? writing;

  CommunityController _controller(WidgetRef ref) =>
      ref.read(communityProvider(community.id).notifier);

  VoidCallback _refreshOf(BuildContext context) {
    final container = ProviderScope.containerOf(context, listen: false);
    final provider = communityProvider(community.id);
    return () {
      if (container.exists(provider)) {
        unawaited(container.read(provider.notifier).refresh());
      }
    };
  }

  Future<void> _set(BuildContext context, WidgetRef ref, bool membersMayPost) async {
    final messenger = ScaffoldMessenger.of(context);
    final refresh = _refreshOf(context);
    sayWriteOutcome(
      messenger,
      await _controller(ref).setChatMode(membersMayPost: membersMayPost),
      refresh: refresh,
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final restricted = community.isRestrictedGroup;
    final idle = writing == null;
    final busy = writing == CommunityWrite.setChatMode;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          CommunityCopy.chatModeSection,
          style: Theme.of(context).textTheme.labelLarge,
        ),
        const SizedBox(height: Insets.sm),
        Text(
          restricted
              ? CommunityCopy.chatModeGroupRestricted
              : CommunityCopy.chatModeGroupOpen,
          style: context.text.bodyMedium,
        ),
        const SizedBox(height: Insets.md),
        OutlinedButton.icon(
          key: const Key('community-chat-mode-toggle'),
          onPressed: idle ? () => _set(context, ref, restricted) : null,
          icon: busy
              ? const BusyIndicator()
              : Icon(restricted ? Icons.edit_rounded : Icons.edit_off_outlined),
          label: Text(
            restricted
                ? CommunityCopy.restorePosting
                : CommunityCopy.restrictPosting,
          ),
        ),
      ],
    );
  }
}

/// The academic halaqa associations (Q50), shown only when the server's `me`
/// holds `canManageHalaqa` (institutional oversight, `communities.manage`).
/// A group or channel may be associated with many halaqat: each is shown —
/// resolved to the halaqa's name, never a bare id — with its own control to
/// remove it, and a button adds another. The links mutate no membership; the
/// server decides again on every request, and refuses an unauthorized caller
/// or a halaqa it does not have.
class _HalaqaManagement extends ConsumerWidget {
  const _HalaqaManagement({required this.community, required this.writing});

  final Community community;
  final CommunityWrite? writing;

  CommunityController _controller(WidgetRef ref) =>
      ref.read(communityProvider(community.id).notifier);

  VoidCallback _refreshOf(BuildContext context) {
    final container = ProviderScope.containerOf(context, listen: false);
    final provider = communityProvider(community.id);
    return () {
      if (container.exists(provider)) {
        unawaited(container.read(provider.notifier).refresh());
      }
    };
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final idle = writing == null;
    final halaqaIds = community.halaqaIds;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          CommunityCopy.halaqaTitle,
          style: Theme.of(context).textTheme.labelLarge,
        ),
        const SizedBox(height: Insets.sm),
        if (halaqaIds.isEmpty)
          const Text(CommunityCopy.halaqaNone)
        else
          for (final halaqaId in halaqaIds)
            _HalaqaRow(
              key: ValueKey(halaqaId),
              halaqaId: halaqaId,
              onUnlink: idle ? () => _unlink(context, ref, halaqaId) : null,
            ),
        const SizedBox(height: Insets.md),
        OutlinedButton.icon(
          onPressed: idle ? () => _link(context, ref) : null,
          icon: writing == CommunityWrite.linkHalaqa
              ? const BusyIndicator()
              : const Icon(Icons.school_outlined),
          label: const Text(CommunityCopy.linkHalaqa),
        ),
      ],
    );
  }

  Future<void> _link(BuildContext context, WidgetRef ref) async {
    final halaqa = await showHalaqaPicker(context);
    if (halaqa == null || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final refresh = _refreshOf(context);
    sayWriteOutcome(
      messenger,
      await _controller(ref).linkHalaqa(halaqa.id),
      refresh: refresh,
      confirmed: true,
    );
  }

  Future<void> _unlink(
    BuildContext context,
    WidgetRef ref,
    String halaqaId,
  ) async {
    final yes = await confirmCommunityChange(
      context,
      question: CommunityCopy.unlinkHalaqaQuestion,
      confirmLabel: CommunityCopy.confirmUnlinkHalaqa,
    );
    if (!yes || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final refresh = _refreshOf(context);
    sayWriteOutcome(
      messenger,
      await _controller(ref).unlinkHalaqa(halaqaId),
      refresh: refresh,
      confirmed: true,
    );
  }
}

/// One academic halaqa association, resolved to the halaqa's name through the
/// academic catalogue (structure only), with a control to remove it. While it
/// resolves, or if it cannot be read, a neutral line stands in — never a bare
/// id. The remove control is disabled while any link change is in flight.
class _HalaqaRow extends ConsumerStatefulWidget {
  const _HalaqaRow({super.key, required this.halaqaId, required this.onUnlink});

  final String halaqaId;
  final VoidCallback? onUnlink;

  @override
  ConsumerState<_HalaqaRow> createState() => _HalaqaRowState();
}

class _HalaqaRowState extends ConsumerState<_HalaqaRow> {
  late Future<AcademicHalaqaDetail?> _detail;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  @override
  void didUpdateWidget(_HalaqaRow old) {
    super.didUpdateWidget(old);
    if (old.halaqaId != widget.halaqaId) _resolve();
  }

  void _resolve() {
    _detail = ref.read(academicRepositoryProvider).halaqa(widget.halaqaId);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.xs),
      child: Row(
        children: [
          const Icon(Icons.school_outlined, size: 20),
          const SizedBox(width: Insets.sm),
          Expanded(
            child: FutureBuilder<AcademicHalaqaDetail?>(
              future: _detail,
              builder: (context, snapshot) =>
                  Text(snapshot.data?.halaqa.name ?? CommunityCopy.halaqaUnnamed),
            ),
          ),
          IconButton(
            onPressed: widget.onUnlink,
            tooltip: CommunityCopy.unlinkHalaqa,
            icon: const Icon(Icons.link_off_rounded),
          ),
        ],
      ),
    );
  }
}

/// Asks messaging for the chat before going there, and says why when it
/// cannot open; disabled while it asks, so one tap is one request.
class _OpenChatButton extends ConsumerStatefulWidget {
  const _OpenChatButton({required this.communityId});

  final String communityId;

  @override
  ConsumerState<_OpenChatButton> createState() => _OpenChatButtonState();
}

class _OpenChatButtonState extends ConsumerState<_OpenChatButton> {
  bool _opening = false;

  Future<void> _open() async {
    setState(() => _opening = true);
    final opening = await ref
        .read(communityChatOpenerProvider)
        .open(widget.communityId);
    if (!mounted) return;
    setState(() => _opening = false);
    switch (opening) {
      case OpenChat(:final location):
        context.push(location);
      case CannotOpenChat(:final message):
        context.toast(message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: _opening ? null : _open,
      icon: _opening ? const BusyIndicator() : const Icon(Icons.forum_outlined),
      label: const Text(CommunityCopy.openChat),
    );
  }
}

/// Starts a live session, then opens the live room; disabled while it asks, so
/// one tap is one request. A refusal — not allowed, the media room could not be
/// made, the community gone — is said in words and nothing opens. The start is
/// idempotent on the server (an already-running session is returned), so this
/// opens the room either way. It reads no live state and touches no media: the
/// room it opens loads the now-running session itself.
class _StartLiveButton extends ConsumerStatefulWidget {
  const _StartLiveButton({required this.communityId});

  final String communityId;

  @override
  ConsumerState<_StartLiveButton> createState() => _StartLiveButtonState();
}

class _StartLiveButtonState extends ConsumerState<_StartLiveButton> {
  bool _starting = false;

  Future<void> _start() async {
    if (_starting) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _starting = true);
    try {
      await ref.read(liveRepositoryProvider).start(widget.communityId);
    } on LiveException catch (error) {
      if (!mounted) return;
      setState(() => _starting = false);
      messenger.toast(CommunityCopy.liveStartFailed(error.code));
      return;
    }
    if (!mounted) return;
    setState(() => _starting = false);
    context.push(Routes.communityLive(widget.communityId));
  }

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      key: const Key('community-start-live'),
      onPressed: _starting ? null : _start,
      icon: _starting
          ? const BusyIndicator()
          : const Icon(Icons.sensors_rounded),
      label: const Text(CommunityCopy.startLive),
    );
  }
}
