import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/theme/messaging_palette.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/communities.dart';
import '../../providers/app_providers.dart';
import '../auth/sign_in_prompt.dart';
import '../messaging/widgets/connection_banner.dart';
import 'community_copy.dart';
import 'state/community_chat_opener.dart';
import 'state/community_list_controller.dart';
import 'widgets/community_states.dart';
import 'widgets/community_tile.dart';
import 'widgets/create_community_sheet.dart';

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
    // OWNER/ADMIN only — the holders of `communities.create`. A hidden button
    // is a courtesy; the server re-authorises the create regardless. Resolves
    // to false while the session loads, or for anyone else (the demo student).
    final canCreate = ref.watch(
      sessionUserProvider.select(
        (session) => session.value?.can('communities.create') ?? false,
      ),
    );
    // The communities surface shares the messaging design system's green/cream
    // palette ([MessagingPalette]), scoped here below the nav shell so the plum
    // nav pill and other tabs are untouched.
    final scaffold = Scaffold(
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
      floatingActionButton: canCreate
          ? FloatingActionButton.extended(
              key: const Key('create-community-fab'),
              onPressed: () => showCreateCommunity(context),
              icon: const Icon(Icons.add_rounded),
              label: const Text(CommunityCopy.createCommunity),
            )
          : null,
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
    return Theme(
      data: MessagingPalette.themeOf(context),
      child: scaffold,
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
                  child: _OpenableCommunityTile(
                    key: ValueKey(community.id),
                    community: community,
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

/// A community row that opens the community's PRIMARY view — its conversation —
/// on tap. It asks messaging for the chat first (the same canonical resolve the
/// in-chat header and the community page's "open chat" button use), so a group
/// and a channel both land on their content view. The community page (its
/// profile, membership and management — what reads as "settings") is reached
/// from the conversation header, an explicit action, never the default on tap.
/// Disabled while it asks, so one tap is one request; a refusal is said in
/// words and nothing opens.
class _OpenableCommunityTile extends ConsumerStatefulWidget {
  const _OpenableCommunityTile({super.key, required this.community});

  final Community community;

  @override
  ConsumerState<_OpenableCommunityTile> createState() =>
      _OpenableCommunityTileState();
}

class _OpenableCommunityTileState
    extends ConsumerState<_OpenableCommunityTile> {
  bool _opening = false;

  Future<void> _open() async {
    if (_opening) return;
    setState(() => _opening = true);
    final opening = await ref
        .read(communityChatOpenerProvider)
        .open(widget.community.id);
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
    return CommunityTile(community: widget.community, onTap: _open);
  }
}
