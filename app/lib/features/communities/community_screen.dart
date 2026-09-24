import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/foundations/stat_badge.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/patterns/info_row.dart';
import '../../data/models/communities.dart';
import '../messaging/widgets/connection_banner.dart';
import 'community_copy.dart';
import 'state/community_chat_opener.dart';
import 'state/community_controller.dart';
import 'widgets/community_states.dart';

/// One community, as the viewer may see it now: whether it is locked, how
/// many are in it, where the viewer stands, and what the server says they
/// may do — every action shown if and only if the server's answer holds it.
///
/// A locked community says it is locked and nothing more: what a lock closes
/// is the server's to decide, and shows only as the actions still offered.
class CommunityScreen extends ConsumerWidget {
  const CommunityScreen({super.key, required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = communityProvider(communityId);
    final value = ref.watch(provider);
    final community = value.value?.community;
    return AppScreen(
      title: community?.title ?? CommunityCopy.detailTitle,
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
                : _Details(community: state.community!),
          ),
        ),
      ],
    );
  }
}

class _Details extends StatelessWidget {
  const _Details({required this.community});

  final Community community;

  @override
  Widget build(BuildContext context) {
    final me = community.me;
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
              Text(community.title, style: context.text.titleLarge),
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
        if (community.canOpenChat || community.canViewMembers) ...[
          const SizedBox(height: Insets.xxl),
          if (community.canOpenChat) _OpenChatButton(communityId: community.id),
          if (community.canOpenChat && community.canViewMembers)
            const SizedBox(height: Insets.md),
          if (community.canViewMembers)
            OutlinedButton.icon(
              onPressed: () =>
                  context.push(Routes.communityMembers(community.id)),
              icon: const Icon(Icons.people_alt_outlined),
              label: const Text(CommunityCopy.viewMembers),
            ),
        ],
      ],
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
      icon: _opening
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.forum_outlined),
      label: const Text(CommunityCopy.openChat),
    );
  }
}
