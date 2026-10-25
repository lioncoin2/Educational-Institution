import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/theme/live_palette.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../data/models/live.dart';
import '../communities/state/community_chat_opener.dart';
import 'live_copy.dart';
import 'state/live_session_controller.dart';
import 'widgets/live_controls.dart';
import 'widgets/live_media_panel.dart';
import 'widgets/live_moderation_actions.dart';
import 'widgets/live_participants.dart';
import 'widgets/live_roster.dart';
import 'widgets/live_soon.dart';
import 'widgets/live_stage.dart';
import 'widgets/live_states.dart';

/// A community's live session, as an immersive broadcast surface ([LivePalette],
/// always dark): a [LiveStage] that fills the room, a bottom control dock, a
/// reactions strip and a bottom tab bar, with the moderator roster as a sheet on
/// phones and a side pane from tablet width up. Loading, error, no-session and
/// ended states are calm centred cards. Every value is the server's; nothing
/// here reaches a transport or an account's roles/permissions, and unbacked
/// reference features are rendered as inert locked placeholders.
class LiveSessionScreen extends ConsumerWidget {
  const LiveSessionScreen({
    super.key,
    required this.communityId,
    this.autoJoin = false,
  });

  final String communityId;

  /// When true (the live banner), the viewer is connected to the session audio
  /// on arrival; false (the default, explicit entries) keeps the join step.
  final bool autoJoin;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = liveSessionProvider(communityId);
    final value = ref.watch(provider);
    return Theme(
      data: LivePalette.themeOf(context),
      child: Builder(
        builder: (context) => value.when(
          loading: () => const _StateScaffold(child: LiveSkeleton()),
          error: (error, _) => _StateScaffold(
            child: LiveErrorView(
              error: error,
              onRetry: () => ref.invalidate(provider),
            ),
          ),
          data: (session) {
            if (session == null) {
              return const _StateScaffold(child: _NoSessionView());
            }
            if (!session.isLive) {
              return _StateScaffold(child: _EndedView(session: session));
            }
            return _LiveRoom(session: session, autoJoin: autoJoin);
          },
        ),
      ),
    );
  }
}

/// The immersive running-session layout.
class _LiveRoom extends ConsumerWidget {
  const _LiveRoom({required this.session, required this.autoJoin});

  final LiveSession session;
  final bool autoJoin;

  void _openParticipants(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => Theme(
        data: LivePalette.themeOf(context),
        child: Builder(
          builder: (context) => DraggableScrollableSheet(
            expand: false,
            initialChildSize: 0.82,
            minChildSize: 0.4,
            maxChildSize: 0.95,
            builder: (context, controller) => DecoratedBox(
              decoration: BoxDecoration(
                color: context.colors.surface,
                borderRadius: const BorderRadius.vertical(top: Radii.xl),
                border: Border.all(color: context.colors.outlineVariant),
              ),
              child: Column(
                children: [
                  const _SheetGrip(),
                  Expanded(
                    child: SingleChildScrollView(
                      controller: controller,
                      padding: const EdgeInsets.fromLTRB(
                        Insets.lg,
                        0,
                        Insets.lg,
                        Insets.giant,
                      ),
                      child: _ParticipantsBody(session: session),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Opens the community's group conversation — the access-checked
  /// [CommunityChatOpener] re-confirms the viewer may read it NOW; a refusal is
  /// said in words, never a silent dead button. This is the GROUP chat, not a
  /// (non-existent) separate in-broadcast chat.
  Future<void> _openChat(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    final opening = await ref
        .read(communityChatOpenerProvider)
        .open(session.communityId);
    if (!context.mounted) return;
    switch (opening) {
      case OpenChat(:final location):
        context.push(location);
      case CannotOpenChat(:final message):
        messenger.toast(message);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final multiPane = !context.breakpoint.isMobile; // ≥600
    final withChat = context.breakpoint.isDesktop; // ≥1024

    final stage = Padding(
      padding: EdgeInsets.fromLTRB(context.gutter, Insets.md, context.gutter, 0),
      child: LiveStage(
        session: session,
        onParticipants: multiPane ? null : () => _openParticipants(context),
      ),
    );

    final center = Column(
      children: [
        if (session.origin.isMock) MockBanner(message: LiveCopy.demoBanner),
        Expanded(child: stage),
        LiveModerationActions(session: session),
        Padding(
          padding: EdgeInsets.symmetric(
            horizontal: context.gutter,
            vertical: Insets.sm,
          ),
          child: const LiveReactionBar(),
        ),
        LiveMediaPanel(session: session, autoJoin: autoJoin),
        if (!multiPane)
          LiveDockBar(
            border: false,
            child: LiveBottomTabs(
              onParticipants: () => _openParticipants(context),
              onChat: () => _openChat(context, ref),
            ),
          ),
      ],
    );

    if (!multiPane) {
      return Scaffold(body: SafeArea(child: center));
    }

    return Scaffold(
      body: SafeArea(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Reference order (RTL): participants on the start side, the stage
            // in the centre, chat on the end side. The participants pane shows
            // for everyone (presence + count); the moderator hand-queue is
            // inside it, gated to moderators.
            SizedBox(
              width: withChat ? 340 : 320,
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(
                  Insets.lg,
                  Insets.lg,
                  Insets.lg,
                  Insets.giant,
                ),
                child: _ParticipantsBody(session: session),
              ),
            ),
            VerticalDivider(width: 1, color: context.colors.outlineVariant),
            Expanded(child: center),
            if (withChat) ...[
              VerticalDivider(width: 1, color: context.colors.outlineVariant),
              SizedBox(
                width: 300,
                child: _ChatColumn(onOpen: () => _openChat(context, ref)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The participants view (sheet on phones, side pane from tablet up): the live
/// presence roster for everyone, and — for moderators only — the hand/floor
/// queue with its commands. A non-moderator never renders [LiveRoster], so the
/// moderators-only `GET /hands` is never called for them.
class _ParticipantsBody extends StatelessWidget {
  const _ParticipantsBody({required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LivePresenceList(session: session),
        if (session.me.canModerate) ...[
          const SizedBox(height: Insets.xxl),
          LiveRoster(session: session),
        ],
      ],
    );
  }
}

/// The reference desktop view's CHAT column. There is no separate in-broadcast
/// chat contract, so instead of faking one this column opens the community's
/// EXISTING group conversation — [onOpen] routes through the access-checked
/// `CommunityChatOpener`, and the wording ([chatGroupHint]) tells the viewer
/// plainly that the chat is the group's, not a standalone broadcast chat.
class _ChatColumn extends StatelessWidget {
  const _ChatColumn({required this.onOpen});

  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.all(Insets.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(LiveCopy.chatGroupTitle, style: context.text.titleMedium),
          const SizedBox(height: Insets.lg),
          Expanded(
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.forum_outlined,
                    size: 36,
                    color: colors.onSurfaceVariant,
                  ),
                  const SizedBox(height: Insets.md),
                  Text(
                    LiveCopy.chatGroupHint,
                    textAlign: TextAlign.center,
                    style: context.text.bodySmall,
                  ),
                ],
              ),
            ),
          ),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              key: const Key('live-chat-open'),
              onPressed: onOpen,
              icon: const Icon(Icons.chat_bubble_outline_rounded, size: 18),
              label: const Text(LiveCopy.chatGroupOpen),
            ),
          ),
        ],
      ),
    );
  }
}

class _SheetGrip extends StatelessWidget {
  const _SheetGrip();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.md),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 40,
            height: 4,
            decoration: BoxDecoration(
              color: context.colors.outlineVariant,
              borderRadius: Radii.pill,
            ),
          ),
        ],
      ),
    );
  }
}

/// A calm, dark scaffold for the non-running states (loading, error, no session,
/// ended): an app bar with a back action and a centred, scrollable card.
class _StateScaffold extends StatelessWidget {
  const _StateScaffold({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text(LiveCopy.title)),
      body: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(
            context.gutter,
            Insets.lg,
            context.gutter,
            Insets.giant,
          ),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

/// No session is running — with honest, inert previews of the reference's
/// scheduled-broadcast card and mini-player (neither is backed yet).
class _NoSessionView extends StatelessWidget {
  const _NoSessionView();

  @override
  Widget build(BuildContext context) {
    return const Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        EmptyState(
          icon: Icons.podcasts_outlined,
          title: LiveCopy.noSession,
          message: LiveCopy.noSessionMessage,
        ),
        SizedBox(height: Insets.lg),
        _ScheduledCard(),
        SizedBox(height: Insets.md),
        _MiniPlayerCard(),
      ],
    );
  }
}

/// The reference's scheduled-broadcast state card — no scheduling model exists,
/// so it is an inert, locked placeholder.
class _ScheduledCard extends StatelessWidget {
  const _ScheduledCard();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Opacity(
      opacity: 0.7,
      child: AppCard(
        child: Row(
          children: [
            Icon(Icons.event_outlined, size: 22, color: colors.onSurfaceVariant),
            const SizedBox(width: Insets.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(LiveCopy.scheduledTitle, style: context.text.titleSmall),
                      const SizedBox(width: Insets.sm),
                      Icon(Icons.lock_outline, size: 14, color: colors.onSurfaceVariant),
                    ],
                  ),
                  const SizedBox(height: Insets.xs),
                  Text(LiveCopy.soonScheduled, style: context.text.bodySmall),
                ],
              ),
            ),
            LiveSoonChip(
              icon: Icons.notifications_none_rounded,
              label: LiveCopy.scheduledRemind,
            ),
          ],
        ),
      ),
    );
  }
}

/// The reference's mini-player — continuing audio while browsing is not
/// supported (the session is screen-scoped), so it is an inert, locked
/// placeholder kept in its reference position.
class _MiniPlayerCard extends StatelessWidget {
  const _MiniPlayerCard();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Opacity(
      opacity: 0.7,
      child: Container(
        padding: const EdgeInsets.all(Insets.md),
        decoration: BoxDecoration(
          color: colors.surfaceContainerHigh,
          borderRadius: Radii.brLg,
          border: Border.all(color: colors.outlineVariant),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: colors.surfaceContainer,
                borderRadius: Radii.brSm,
              ),
              child: Icon(Icons.graphic_eq_rounded, color: colors.onSurfaceVariant),
            ),
            const SizedBox(width: Insets.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(LiveCopy.miniPlayerTitle, style: context.text.titleSmall),
                      const SizedBox(width: Insets.sm),
                      Icon(Icons.lock_outline, size: 14, color: colors.onSurfaceVariant),
                    ],
                  ),
                  const SizedBox(height: Insets.xs),
                  Text(LiveCopy.miniPlayerBody, style: context.text.bodySmall),
                ],
              ),
            ),
            Icon(Icons.play_arrow_rounded, color: colors.onSurfaceVariant),
          ],
        ),
      ),
    );
  }
}

/// A session the server no longer reports as live — the ended state card with
/// how long it ran and an inert "watch recording" placeholder.
class _EndedView extends StatelessWidget {
  const _EndedView({required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context) {
    final duration = session.endedAt?.difference(session.startedAt);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
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
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.podcasts_outlined,
                    size: 22,
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
                          style: context.text.bodySmall,
                        ),
                        if (duration != null) ...[
                          const SizedBox(height: Insets.sm),
                          Text(
                            LiveCopy.sessionDuration(duration),
                            style: context.text.bodySmall,
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: Insets.lg),
              const Align(
                alignment: AlignmentDirectional.centerStart,
                child: LiveSoonAction(
                  icon: Icons.play_circle_outline,
                  label: LiveCopy.soonRecordingWatch,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
