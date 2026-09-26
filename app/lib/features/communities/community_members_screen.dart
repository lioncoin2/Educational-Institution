import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/communities.dart';
import '../messaging/widgets/connection_banner.dart';
import 'community_copy.dart';
import 'state/community_controller.dart';
import 'state/community_members_controller.dart';
import 'state/community_viewer.dart';
import 'state/community_write.dart';
import 'widgets/community_change.dart';
import 'widgets/community_states.dart';
import 'widgets/member_capabilities_sheet.dart';
import 'widgets/member_tile.dart';

/// A community's roster — for a viewer the server lets see it — a page at a
/// time: rows are built as they scroll into view, and the next page is
/// fetched only when asked for. A 30,000-member community is never loaded
/// whole.
///
/// A row's actions are what the server's `me` offers — the member's
/// capabilities (`me.operations` ∋ community.grants.manage), handing the
/// community over (∋ community.ownership.transfer), removing them
/// (`me.capabilities` ∋ community.members.remove) — behind one button per
/// row, and on no row that could be the viewer's own. Rows carry no standing
/// and no eligibility: whether this member may be removed or handed the
/// community is the server's answer to the request.
class CommunityMembersScreen extends ConsumerWidget {
  const CommunityMembersScreen({super.key, required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = communityMembersProvider(communityId);
    final value = ref.watch(provider);
    // The community's name, when its screen already knows it — and what the
    // viewer may do in it now.
    final community = ref.watch(
      communityProvider(communityId).select((v) {
        final detail = v.value;
        return (
          title: detail?.community?.title,
          me: detail == null || detail.removed ? null : detail.community?.me,
        );
      }),
    );
    final viewerId = ref.watch(communityViewerIdProvider);
    return AppScreen(
      title: CommunityCopy.membersTitle,
      subtitle: community.title,
      actions: [
        IconButton(
          tooltip: CommunityCopy.refresh,
          onPressed: () => ref.invalidate(provider),
          icon: const Icon(Icons.refresh_rounded),
        ),
        const SizedBox(width: Insets.sm),
      ],
      slivers: [
        const SliverToBoxAdapter(child: ConnectionBanner()),
        ...value.when(
          loading: () => const [
            SliverGutter(top: Insets.lg, child: CommunitySkeleton(height: 64)),
          ],
          error: (error, _) => [
            SliverGutter(
              top: Insets.lg,
              child: CommunityErrorView(
                error: error,
                onRetry: () => ref.invalidate(provider),
              ),
            ),
          ],
          data: (state) => _roster(
            state,
            actions: _MemberAction.allowedBy(community.me),
            viewerId: viewerId,
          ),
        ),
      ],
    );
  }

  List<Widget> _roster(
    CommunityMembersState state, {
    required List<_MemberAction> actions,
    required String? viewerId,
  }) {
    if (state.gone) {
      return [
        SliverGutter(
          top: Insets.lg,
          child: CommunityGoneView(wasShown: state.removed),
        ),
      ];
    }
    if (state.forbidden) {
      return const [
        SliverGutter(
          top: Insets.lg,
          child: EmptyState(
            icon: Icons.lock_outline_rounded,
            title: CommunityCopy.membersForbidden,
          ),
        ),
      ];
    }
    if (state.items.isEmpty) {
      return const [
        SliverGutter(
          top: Insets.lg,
          child: EmptyState(
            icon: Icons.groups_outlined,
            title: CommunityCopy.membersEmpty,
          ),
        ),
      ];
    }
    return [
      if (state.items.first.origin.isMock)
        const SliverGutter(
          top: Insets.lg,
          child: MockBanner(message: CommunityCopy.demoMembers),
        ),
      SliverPadding(
        padding: const EdgeInsets.only(top: Insets.md),
        sliver: SliverList.builder(
          itemCount: state.items.length,
          itemBuilder: (context, index) {
            final member = state.items[index];
            // With nobody known to be the viewer, any row could be theirs.
            final own = viewerId == null || member.userId == viewerId;
            return ResponsiveBody(
              child: Padding(
                padding: const EdgeInsets.only(bottom: Insets.sm),
                child: MemberTile(
                  key: ValueKey(member.userId),
                  member: member,
                  action: own || actions.isEmpty
                      ? null
                      : _MemberActionsButton(
                          communityId: communityId,
                          member: member,
                          actions: actions,
                          busy: state.writing.containsKey(member.userId),
                        ),
                ),
              ),
            );
          },
        ),
      ),
      SliverGutter(
        child: _Footer(communityId: communityId, state: state),
      ),
    ];
  }
}

/// What may be done with a member, as the server's `me` offers it.
enum _MemberAction {
  capabilities(Icons.admin_panel_settings_outlined),
  makeOwner(Icons.swap_horiz_rounded),
  remove(Icons.person_remove_outlined);

  const _MemberAction(this.icon);

  final IconData icon;

  String get label => switch (this) {
    capabilities => CommunityCopy.memberCapabilities,
    makeOwner => CommunityCopy.makeOwner,
    remove => CommunityCopy.removeMember,
  };

  static List<_MemberAction> allowedBy(CommunityMe? me) => me == null
      ? const []
      : [
          if (me.allows(CommunityOperation.grantsManage)) capabilities,
          if (me.allows(CommunityOperation.ownershipTransfer)) makeOwner,
          if (me.has(CommunityCapability.membersRemove)) remove,
        ];
}

/// A row's actions: a sheet of what the server offers for this member.
/// While a change to them is on its way it spins, and sends nothing more.
class _MemberActionsButton extends ConsumerWidget {
  const _MemberActionsButton({
    required this.communityId,
    required this.member,
    required this.actions,
    required this.busy,
  });

  final String communityId;
  final CommunityMember member;
  final List<_MemberAction> actions;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return IconButton(
      tooltip: CommunityCopy.memberOptions(member),
      onPressed: busy ? null : () => _choose(context, ref),
      icon: busy ? const BusyIndicator() : const Icon(Icons.more_vert_rounded),
    );
  }

  Future<void> _choose(BuildContext context, WidgetRef ref) async {
    final action = await showModalBottomSheet<_MemberAction>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: Insets.xxl,
                vertical: Insets.sm,
              ),
              child: Text(
                CommunityCopy.memberName(member),
                style: context.text.titleMedium,
              ),
            ),
            for (final action in actions)
              ListTile(
                leading: Icon(action.icon),
                title: Text(action.label),
                onTap: () => Navigator.pop(context, action),
              ),
          ],
        ),
      ),
    );
    if (action == null || !context.mounted) return;
    switch (action) {
      case _MemberAction.capabilities:
        await showMemberCapabilities(
          context,
          communityId: communityId,
          member: member,
        );
      case _MemberAction.makeOwner:
        await _transfer(context, ref);
      case _MemberAction.remove:
        await _remove(context, ref);
    }
  }

  CommunityMembersController _roster(WidgetRef ref) =>
      ref.read(communityMembersProvider(communityId).notifier);

  Future<void> _remove(BuildContext context, WidgetRef ref) async {
    final yes = await confirmCommunityChange(
      context,
      question: CommunityCopy.removeQuestion(member),
      confirmLabel: CommunityCopy.confirmRemove,
      destructive: true,
    );
    if (!yes || !context.mounted) return;
    // Held before: once removed, this row — and its context — is gone.
    final messenger = ScaffoldMessenger.of(context);
    final outcome = await _roster(ref).remove(member.userId);
    if (outcome case WriteFailed(:final error)) {
      messenger.toast(CommunityCopy.writeFailed(error.code));
    }
  }

  /// Done, the viewer goes back to the community, where their standing in
  /// it — as the server now answers — is shown.
  Future<void> _transfer(BuildContext context, WidgetRef ref) async {
    final yes = await confirmCommunityChange(
      context,
      question: CommunityCopy.transferQuestion(member),
      confirmLabel: CommunityCopy.confirmTransfer,
    );
    if (!yes || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    final outcome = await _roster(ref).transferOwnership(member.userId);
    switch (outcome) {
      case WriteDone():
        messenger.toast(CommunityCopy.ownershipTransferred);
        if (router.canPop()) {
          router.pop();
        } else {
          router.go(Routes.community(communityId));
        }
      case WriteFailed(:final error):
        messenger.toast(CommunityCopy.writeFailed(error.code));
      case WriteNotSent():
        break;
    }
  }
}

/// The end of what is loaded: more to load, loading, or a retry.
class _Footer extends ConsumerWidget {
  const _Footer({required this.communityId, required this.state});

  final String communityId;
  final CommunityMembersState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!state.hasMore) return const SizedBox.shrink();
    if (state.loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: () =>
            ref.read(communityMembersProvider(communityId).notifier).loadMore(),
        child: Text(
          state.loadMoreFailed
              ? CommunityCopy.loadMoreFailed
              : CommunityCopy.loadMore,
        ),
      ),
    );
  }
}
