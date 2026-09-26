import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/communities.dart';
import '../../providers/app_providers.dart';
import '../messaging/widgets/connection_banner.dart';
import 'community_copy.dart';
import 'state/community_controller.dart';
import 'state/community_invitations_controller.dart';
import 'state/community_viewer.dart';
import 'state/community_write.dart';
import 'widgets/community_change.dart';
import 'widgets/community_states.dart';
import 'widgets/invitation_tile.dart';
import 'widgets/one_time_link_sheet.dart';

/// A community's invitation links (`/communities/:id/invitations`): each
/// link as the server lists it, newest first, a page at a time — its state,
/// when it ends, its uses, and whether the viewer made it.
///
/// What is offered here is the server's `me`: revoking a link (asked first)
/// needs `me.operations` ∋ community.invitations.manage; a new link needs
/// `me.capabilities` ∋ community.members.invite — and an address to write it
/// at, which only the web app has. Anywhere else a note says where links
/// are made. A new link's token is shown once, in a sheet, and kept nowhere.
class CommunityInvitationsScreen extends ConsumerWidget {
  const CommunityInvitationsScreen({super.key, required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = communityInvitationsProvider(communityId);
    final value = ref.watch(provider);
    final detail = ref.watch(communityProvider(communityId)).value;
    final me = detail == null || detail.removed ? null : detail.community?.me;
    return AppScreen(
      title: CommunityCopy.invitationLinks,
      subtitle: detail?.community?.title,
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
            SliverGutter(top: Insets.lg, child: CommunitySkeleton(height: 96)),
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
          data: (state) => _links(
            ref,
            state,
            me: me,
            wasShown: detail?.community != null,
            viewerId: ref.watch(communityViewerIdProvider),
          ),
        ),
      ],
    );
  }

  List<Widget> _links(
    WidgetRef ref,
    CommunityInvitationsState state, {
    required CommunityMe? me,
    required bool wasShown,
    required String? viewerId,
  }) {
    if (state.gone) {
      return [
        SliverGutter(
          top: Insets.lg,
          child: CommunityGoneView(wasShown: wasShown),
        ),
      ];
    }
    if (state.forbidden) {
      return const [
        SliverGutter(
          top: Insets.lg,
          child: EmptyState(
            icon: Icons.lock_outline_rounded,
            title: CommunityCopy.invitationsForbidden,
          ),
        ),
      ];
    }
    final mayRevoke = me?.allows(CommunityOperation.invitationsManage) ?? false;
    return [
      if (me?.has(CommunityCapability.membersInvite) ?? false)
        SliverGutter(
          top: Insets.lg,
          child: _CreateLink(
            communityId: communityId,
            creating: state.creating,
          ),
        ),
      if (state.items.isEmpty)
        const SliverGutter(
          top: Insets.lg,
          child: EmptyState(
            icon: Icons.link_rounded,
            title: CommunityCopy.invitationsEmpty,
          ),
        )
      else ...[
        if (state.items.first.origin.isMock)
          const SliverGutter(
            top: Insets.lg,
            child: MockBanner(message: CommunityCopy.demoInvitations),
          ),
        SliverPadding(
          padding: const EdgeInsets.only(top: Insets.md),
          sliver: SliverList.builder(
            itemCount: state.items.length,
            itemBuilder: (context, index) {
              final invitation = state.items[index];
              final revoking = state.revoking.contains(invitation.id);
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.sm),
                  child: InvitationTile(
                    key: ValueKey(invitation.id),
                    invitation: invitation,
                    mine: viewerId != null && invitation.createdBy == viewerId,
                    revoking: revoking,
                    onRevoke:
                        mayRevoke &&
                            invitation.state != InvitationState.revoked &&
                            !revoking
                        ? () => _revoke(context, ref, invitation)
                        : null,
                  ),
                ),
              );
            },
          ),
        ),
        SliverGutter(
          child: _Footer(communityId: communityId, state: state),
        ),
      ],
    ];
  }

  Future<void> _revoke(
    BuildContext context,
    WidgetRef ref,
    CommunityInvitation invitation,
  ) async {
    final yes = await confirmCommunityChange(
      context,
      question: CommunityCopy.revokeLinkQuestion,
      confirmLabel: CommunityCopy.revokeLink,
      destructive: true,
    );
    if (!yes || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final outcome = await ref
        .read(communityInvitationsProvider(communityId).notifier)
        .revoke(invitation.id);
    if (outcome case WriteFailed(:final error)) {
      messenger.toast(CommunityCopy.writeFailed(error.code));
    }
  }
}

/// Making a new link — where this build can write one. It is one request,
/// never repeated on its own; its link is shown once, in a sheet.
class _CreateLink extends ConsumerWidget {
  const _CreateLink({required this.communityId, required this.creating});

  final String communityId;
  final bool creating;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final linkFor = ref.watch(inviteLinkBuilderProvider);
    if (linkFor == null) {
      return Row(
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
              CommunityCopy.linksOnWeb,
              style: context.text.bodyMedium,
            ),
          ),
        ],
      );
    }
    return FilledButton.icon(
      onPressed: creating ? null : () => _create(context, ref, linkFor),
      icon: creating
          ? const BusyIndicator()
          : const Icon(Icons.add_link_rounded),
      label: const Text(CommunityCopy.createLink),
    );
  }

  Future<void> _create(
    BuildContext context,
    WidgetRef ref,
    InviteLinkBuilder linkFor,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final outcome = await ref
        .read(communityInvitationsProvider(communityId).notifier)
        .create();
    switch (outcome) {
      case WriteDone(value: final created):
        final link = linkFor(created.token);
        if (link == null || !context.mounted) {
          // Made, and not to be shown: it can still be revoked from the
          // list — and it is never asked for again.
          messenger.toast(CommunityCopy.linkNotShown);
          return;
        }
        await showOneTimeLinkSheet(context, link);
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
  final CommunityInvitationsState state;

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
        onPressed: () => ref
            .read(communityInvitationsProvider(communityId).notifier)
            .loadMore(),
        child: Text(
          state.loadMoreFailed
              ? CommunityCopy.loadMoreFailed
              : CommunityCopy.loadMore,
        ),
      ),
    );
  }
}
