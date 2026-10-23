import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/live.dart';
import 'live_copy.dart';
import 'state/live_session_controller.dart';
import 'widgets/live_hand_control.dart';
import 'widgets/live_media_panel.dart';
import 'widgets/live_moderation_actions.dart';
import 'widgets/live_roster.dart';
import 'widgets/live_screen_share.dart';
import 'widgets/live_states.dart';

/// A community's live session: whether one is running now, who hosts it, and
/// how many hold the floor — every fact the server's, never worked out here —
/// together with the viewer's own media participation (joining the audio, the
/// microphone, and a presenter's screen-share capture) behind the media seam
/// (lib/data/media/live_media_seams.dart). Media is transport only; a build
/// with no provider bound shows it as unavailable. Authority — who may join or
/// present — stays the server's `me`, and the media connection is never
/// attendance or a second source of session truth.
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

class _SessionView extends StatelessWidget {
  const _SessionView({required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context) {
    // The server's state is the truth: a session no longer live shows the
    // ended card and no acting controls — never a stale "live" view.
    if (!session.isLive) return _EndedView(session: session);

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
        // The broadcaster's shared screen, when one is sharing — rendered for
        // eligible participants (Requirement B). Shows nothing when no one is
        // sharing, and nothing where no real media provider is bound.
        const LiveScreenShare(),
        // The viewer's own hand — ask for the floor, or lower it / yield once
        // up. Shown only as the server's `me` allows (canRaiseHand, or an open
        // hand). Authority stays the server's; granting the floor permits
        // speaking, but the audio itself is the media seam below.
        LiveHandControl(session: session),
        // The viewer's own place in the session audio — joining, the
        // microphone and (for a presenter) the screen-share capture, behind
        // the media seam. Unavailable in a build with no provider bound; the
        // panel says so. Media is transport only, never authority, attendance,
        // or a second source of session truth.
        LiveMediaPanel(session: session),
        // The viewer's own controls, each shown only as the server's `me`
        // allows. A command never mutates this view; the realtime
        // reconciliation (Slice 4) brings the authoritative session after.
        LiveModerationActions(session: session),
        // A moderator's roster of raised hands and speakers, with the
        // per-person authority commands (Q56/Q64). Reading the queue needs
        // moderator standing — shown only when the server's own `me` grants it;
        // every command still goes to the server, which decides afresh.
        if (me.canModerate) LiveRoster(session: session),
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
