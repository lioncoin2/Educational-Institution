import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../messaging/widgets/connection_banner.dart';
import 'community_copy.dart';
import 'state/community_controller.dart';
import 'state/community_members_controller.dart';
import 'widgets/community_states.dart';
import 'widgets/member_tile.dart';

/// A community's roster — for a viewer the server lets see it — a page at a
/// time: rows are built as they scroll into view, and the next page is
/// fetched only when asked for. A 30,000-member community is never loaded
/// whole.
class CommunityMembersScreen extends ConsumerWidget {
  const CommunityMembersScreen({super.key, required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = communityMembersProvider(communityId);
    final value = ref.watch(provider);
    // The community's name, when its screen already knows it.
    final title = ref.watch(
      communityProvider(communityId).select((v) => v.value?.community?.title),
    );
    return AppScreen(
      title: CommunityCopy.membersTitle,
      subtitle: title,
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
          data: (state) => _roster(state),
        ),
      ],
    );
  }

  List<Widget> _roster(CommunityMembersState state) {
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
            return ResponsiveBody(
              child: Padding(
                padding: const EdgeInsets.only(bottom: Insets.sm),
                child: MemberTile(key: ValueKey(member.userId), member: member),
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
