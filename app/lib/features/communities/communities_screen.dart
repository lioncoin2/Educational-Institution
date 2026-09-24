import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../providers/app_providers.dart';
import '../auth/sign_in_prompt.dart';
import '../messaging/widgets/connection_banner.dart';
import 'community_copy.dart';
import 'state/community_list_controller.dart';
import 'widgets/community_states.dart';
import 'widgets/community_tile.dart';

/// مجتمعاتي — the communities the signed-in person belongs to, most recently
/// joined first, kept current live while it is open.
///
/// Against the backend a session comes first; the demo runs on mock data,
/// marked as such, and needs none.
class CommunitiesScreen extends ConsumerWidget {
  const CommunitiesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final backend = ref.watch(backendModeProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(CommunityCopy.screenTitle),
        actions: [
          IconButton(
            tooltip: CommunityCopy.refresh,
            onPressed: () => ref.invalidate(communityListProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: backend
            ? AsyncView(
                value: ref.watch(sessionUserProvider),
                onRetry: () => ref.invalidate(sessionUserProvider),
                builder: (context, user) => user == null
                    ? const SingleChildScrollView(
                        child: SignInPrompt(title: CommunityCopy.signInTitle),
                      )
                    : const Column(
                        children: [
                          ConnectionBanner(),
                          Expanded(child: _CommunityList()),
                        ],
                      ),
              )
            : const _CommunityList(),
      ),
    );
  }
}

class _CommunityList extends ConsumerWidget {
  const _CommunityList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final communities = ref.watch(communityListProvider);
    return AsyncView(
      value: communities,
      loading: const SingleChildScrollView(
        child: ResponsiveBody(
          child: Padding(
            padding: EdgeInsets.only(top: Insets.md),
            child: CommunitySkeleton(),
          ),
        ),
      ),
      errorBuilder: (context, error) => SingleChildScrollView(
        child: CommunityErrorView(
          error: error,
          onRetry: () => ref.invalidate(communityListProvider),
        ),
      ),
      builder: (context, state) {
        if (state.items.isEmpty) {
          return const SingleChildScrollView(
            child: EmptyState(
              icon: Icons.groups_outlined,
              title: CommunityCopy.empty,
              message: CommunityCopy.emptyMessage,
            ),
          );
        }
        final demo = state.items.any((c) => c.origin.isMock);
        return RefreshIndicator(
          onRefresh: () => ref.read(communityListProvider.notifier).refresh(),
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: Insets.giant),
            itemCount: state.items.length + 2,
            itemBuilder: (context, index) {
              if (index == 0) {
                return demo
                    ? const ResponsiveBody(
                        child: Padding(
                          padding: EdgeInsets.symmetric(vertical: Insets.md),
                          child: MockBanner(message: CommunityCopy.demoBanner),
                        ),
                      )
                    : const SizedBox(height: Insets.md);
              }
              if (index == state.items.length + 1) return _Footer(state: state);
              final community = state.items[index - 1];
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.sm),
                  child: CommunityTile(
                    key: ValueKey(community.id),
                    community: community,
                    onTap: () => context.push(Routes.community(community.id)),
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }
}

/// The end of the list: more to load, loading, or a retry after a failure.
class _Footer extends ConsumerWidget {
  const _Footer({required this.state});

  final CommunityListState state;

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
        onPressed: () => ref.read(communityListProvider.notifier).loadMore(),
        child: Text(
          state.loadMoreFailed
              ? CommunityCopy.loadMoreFailed
              : CommunityCopy.loadMore,
        ),
      ),
    );
  }
}
