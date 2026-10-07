import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/live.dart';
import '../../providers/app_providers.dart';
import 'live_copy.dart';
import 'state/live_session_controller.dart';
import 'widgets/live_moderation_actions.dart';
import 'widgets/live_states.dart';

/// A community's live session, read-only: whether one is running now, who
/// hosts it, and how many hold the floor — every fact the server's, never
/// worked out here. The media area states plainly that live audio is not
/// available in this build; joining is a later milestone behind its own seam
/// (lib/data/media/live_media_seams.dart), so this screen never implies that
/// voice works.
class LiveSessionScreen extends ConsumerWidget {
  const LiveSessionScreen({super.key, required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = liveSessionProvider(communityId);
    final value = ref.watch(provider);
    return AppScreen(
      title: LiveCopy.title,
      actions: [
        IconButton(
          tooltip: LiveCopy.refresh,
          onPressed: () => ref.read(provider.notifier).refresh(),
          icon: const Icon(Icons.refresh_rounded),
        ),
        const SizedBox(width: Insets.sm),
      ],
      slivers: [
        SliverGutter(
          top: Insets.lg,
          child: AsyncView(
            value: value,
            loading: const LiveSkeleton(),
            errorBuilder: (context, error) => LiveErrorView(
              error: error,
              onRetry: () => ref.invalidate(provider),
            ),
            builder: (context, session) {
              if (session == null) {
                return const EmptyState(
                  icon: Icons.podcasts_outlined,
                  title: LiveCopy.noSession,
                  message: LiveCopy.noSessionMessage,
                );
              }
              return _SessionView(session: session);
            },
          ),
        ),
      ],
    );
  }
}

class _SessionView extends ConsumerWidget {
  const _SessionView({required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The server's state is the truth: a session no longer live shows the
    // ended card and no acting controls — never a stale "live" view.
    if (!session.isLive) return _EndedView(session: session);

    // Media is a separate seam; reading it here keeps it out of session
    // loading. Unavailable in this build — the UI says so, never pretends.
    final mediaAvailable = ref.watch(liveMediaClientProvider).isAvailable;
    final me = session.me;
    final moderation = session.moderation;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (session.origin.isMock) ...[
          const MockBanner(message: LiveCopy.demoBanner),
          const SizedBox(height: Insets.lg),
        ],
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.podcasts_rounded,
                    size: 20,
                    color: context.colors.primary,
                  ),
                  const SizedBox(width: Insets.sm),
                  Text(LiveCopy.liveNow, style: context.text.titleMedium),
                ],
              ),
              const SizedBox(height: Insets.sm),
              Text(
                LiveCopy.speakers(session.speakerCount),
                style: context.text.bodyMedium,
              ),
              if (me.isHost) ...[
                const SizedBox(height: Insets.sm),
                Text(LiveCopy.youHost, style: context.text.bodySmall),
              ] else if (me.canModerate) ...[
                const SizedBox(height: Insets.sm),
                Text(LiveCopy.youModerate, style: context.text.bodySmall),
              ],
              if (me.presenting) ...[
                const SizedBox(height: Insets.sm),
                Text(LiveCopy.youPresent, style: context.text.bodySmall),
              ],
              // A moderator's pending-hand count (the server's figure); never
              // the queue itself, which is the media/floor flow.
              if (moderation != null) ...[
                const SizedBox(height: Insets.sm),
                Text(
                  LiveCopy.pendingHands(moderation.pendingHands),
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: Insets.xxl),
        const SectionHeader(title: LiveCopy.audioSection),
        const SizedBox(height: Insets.md),
        if (!mediaAvailable)
          AppCard(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.volume_off_rounded,
                  size: 18,
                  color: context.colors.onSurfaceVariant,
                ),
                const SizedBox(width: Insets.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        LiveCopy.audioUnavailable,
                        style: context.text.bodyMedium,
                      ),
                      const SizedBox(height: Insets.xs),
                      Text(
                        LiveCopy.audioUnavailableMessage,
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        // The viewer's own controls, each shown only as the server's `me`
        // allows. A command never mutates this view; the realtime
        // reconciliation (Slice 4) brings the authoritative session after.
        LiveModerationActions(session: session),
      ],
    );
  }
}

/// A session the server no longer reports as live — ended or closed. It carries
/// no acting controls: the moderator's tools belong to a running session only.
class _EndedView extends StatelessWidget {
  const _EndedView({required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (session.origin.isMock) ...[
          const MockBanner(message: LiveCopy.demoBanner),
          const SizedBox(height: Insets.lg),
        ],
        AppCard(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.podcasts_outlined,
                size: 20,
                color: context.colors.onSurfaceVariant,
              ),
              const SizedBox(width: Insets.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      LiveCopy.sessionEnded,
                      style: context.text.titleMedium,
                    ),
                    const SizedBox(height: Insets.xs),
                    Text(
                      LiveCopy.sessionEndedMessage,
                      style: context.text.bodySmall?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
