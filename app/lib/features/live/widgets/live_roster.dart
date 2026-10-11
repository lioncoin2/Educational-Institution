import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../core/widgets/foundations/empty_state.dart';
import '../../../core/widgets/foundations/section_header.dart';
import '../../../data/models/live.dart';
import '../live_copy.dart';
import '../state/live_hands_controller.dart';
import '../state/live_moderation_controller.dart';
import 'live_moderation_actions.dart';

/// The filter the moderator can pick for the roster. A non-null value for each,
/// because a `PopupMenuButton` reads a `null` selection as a cancel; `all` maps
/// to the repository's `null` state (every hand).
enum _HandsFilter { all, pending, granted }

LiveHandsFilter? _stateOf(_HandsFilter filter) => switch (filter) {
  _HandsFilter.all => null,
  _HandsFilter.pending => LiveHandsFilter.pending,
  _HandsFilter.granted => LiveHandsFilter.granted,
};

/// The moderator's roster for a running session (Q56/Q64): who has a raised
/// hand or holds the floor, and the per-person authority commands — remove from
/// the session, and delegate or revoke a screen-share (presenter) slot. It is
/// shown only when the session's own `me.canModerate` allows it (the screen
/// gates it); every command still goes to the server, which decides afresh.
///
/// It reads [liveHandsProvider] a page at a time and, after a command, re-reads
/// that list (the queue has no realtime feed in this build) — never applying a
/// command's own result. Media (the screen capture, audio) is a separate seam,
/// unavailable in this build and never implied by these authority controls.
class LiveRoster extends ConsumerStatefulWidget {
  const LiveRoster({super.key, required this.session});

  final LiveSession session;

  @override
  ConsumerState<LiveRoster> createState() => _LiveRosterState();
}

class _LiveRosterState extends ConsumerState<LiveRoster> {
  _HandsFilter _filter = _HandsFilter.all;

  LiveHandsQuery get _query =>
      (sessionId: widget.session.id, state: _stateOf(_filter));

  @override
  Widget build(BuildContext context) {
    final hands = ref.watch(liveHandsProvider(_query));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Insets.xxl),
        SectionHeader(
          title: LiveCopy.rosterSection,
          trailing: PopupMenuButton<_HandsFilter>(
            tooltip: LiveCopy.rosterFilterTooltip,
            icon: const Icon(Icons.filter_list_rounded),
            initialValue: _filter,
            onSelected: (value) => setState(() => _filter = value),
            itemBuilder: (context) => const [
              PopupMenuItem(
                value: _HandsFilter.all,
                child: Text(LiveCopy.rosterFilterAll),
              ),
              PopupMenuItem(
                value: _HandsFilter.pending,
                child: Text(LiveCopy.rosterFilterPending),
              ),
              PopupMenuItem(
                value: _HandsFilter.granted,
                child: Text(LiveCopy.rosterFilterGranted),
              ),
            ],
          ),
        ),
        const SizedBox(height: Insets.md),
        ...hands.when(
          loading: () => const [SkeletonBox(height: 72)],
          error: (error, _) => [
            _RosterError(
              onRetry: () => ref.invalidate(liveHandsProvider(_query)),
            ),
          ],
          data: (state) => _rows(state),
        ),
      ],
    );
  }

  List<Widget> _rows(LiveHandsState state) {
    if (state.items.isEmpty) {
      return const [
        EmptyState(icon: Icons.pan_tool_outlined, title: LiveCopy.rosterEmpty),
      ];
    }
    return [
      for (final hand in state.items) ...[
        _HandCard(
          key: ValueKey(hand.id),
          session: widget.session,
          hand: hand,
          onActed: () => ref.read(liveHandsProvider(_query).notifier).refresh(),
        ),
        const SizedBox(height: Insets.sm),
      ],
      _RosterLoadMore(
        hasMore: state.hasMore,
        loadingMore: state.loadingMore,
        loadMoreFailed: state.loadMoreFailed,
        onLoadMore: () =>
            ref.read(liveHandsProvider(_query).notifier).loadMore(),
      ),
    ];
  }
}

/// One person on the roster — their resolved name (or a neutral fallback), what
/// they are (a raised hand or the floor) and, for the floor, their last-observed
/// connection — with the commands a moderator may run on them. The host is never
/// a target, so their row carries no commands.
class _HandCard extends StatelessWidget {
  const _HandCard({
    super.key,
    required this.session,
    required this.hand,
    required this.onActed,
  });

  final LiveSession session;
  final LiveHand hand;
  final Future<void> Function() onActed;

  @override
  Widget build(BuildContext context) {
    final isHost = hand.userId == session.hostUserId;
    final isPresenter = session.presenterUserIds.contains(hand.userId);
    final name = (hand.displayName != null && hand.displayName!.isNotEmpty)
        ? hand.displayName!
        : LiveCopy.participantFallback;
    final media = _mediaLabel(hand.media);
    final subtitle = media == null
        ? _stateLabel(hand.state)
        : '${_stateLabel(hand.state)} · $media';
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(name, style: context.text.titleSmall)),
              if (isPresenter) ...[
                const SizedBox(width: Insets.sm),
                const _PresenterBadge(),
              ],
            ],
          ),
          const SizedBox(height: Insets.xs),
          Text(
            subtitle,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          if (!isHost) ...[
            const SizedBox(height: Insets.md),
            Wrap(
              spacing: Insets.sm,
              runSpacing: Insets.sm,
              children: [
                if (isPresenter)
                  _RosterCommand(
                    key: Key('live-revoke-presenter-${hand.userId}'),
                    label: LiveCopy.revokePresenter,
                    icon: Icons.cancel_presentation_outlined,
                    successMessage: LiveCopy.revokePresenterDone,
                    action: (c) => c.revokePresenter(session.id, hand.userId),
                    onDone: onActed,
                  )
                else
                  _RosterCommand(
                    key: Key('live-grant-presenter-${hand.userId}'),
                    label: LiveCopy.grantPresenter,
                    icon: Icons.co_present_outlined,
                    successMessage: LiveCopy.grantPresenterDone,
                    action: (c) => c.grantPresenter(session.id, hand.userId),
                    onDone: onActed,
                  ),
                _RosterCommand(
                  key: Key('live-remove-${hand.userId}'),
                  label: LiveCopy.removeParticipant,
                  icon: Icons.person_remove_outlined,
                  destructive: true,
                  confirmQuestion: LiveCopy.removeParticipantQuestion,
                  confirmLabel: LiveCopy.removeParticipantConfirm,
                  successMessage: LiveCopy.removeParticipantDone,
                  action: (c) => c.removeParticipant(session.id, hand.userId),
                  onDone: onActed,
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

String _stateLabel(SpeakerRequestState state) => switch (state) {
  SpeakerRequestState.pending => LiveCopy.handPending,
  SpeakerRequestState.granted => LiveCopy.handGranted,
  _ => LiveCopy.handOther,
};

String? _mediaLabel(LiveObservedMedia? media) => switch (media) {
  LiveObservedMedia.connected => LiveCopy.mediaConnected,
  LiveObservedMedia.notConnected => LiveCopy.mediaNotConnected,
  _ => null,
};

/// A small chip that says this person holds a presenter slot now.
class _PresenterBadge extends StatelessWidget {
  const _PresenterBadge();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.sm,
        vertical: Insets.xs,
      ),
      decoration: BoxDecoration(
        color: context.colors.secondaryContainer,
        borderRadius: Radii.pill,
      ),
      child: Text(
        LiveCopy.presenterBadge,
        style: context.text.labelSmall?.copyWith(
          color: context.colors.onSecondaryContainer,
        ),
      ),
    );
  }
}

/// One per-person moderator command as a compact button that owns its in-flight
/// state (disabled with a spinner while on its way, so a second tap sends
/// nothing). A destructive command is asked first. On success it re-reads the
/// roster through [onDone] — never applying the command's own result — and says
/// so; a refusal is said through the server's code. The command-button pattern
/// of [LiveModerationActions], kept local to the roster rather than shared.
class _RosterCommand extends ConsumerStatefulWidget {
  const _RosterCommand({
    super.key,
    required this.label,
    required this.icon,
    required this.successMessage,
    required this.action,
    this.onDone,
    this.confirmQuestion,
    this.confirmLabel,
    this.destructive = false,
  });

  final String label;
  final IconData icon;
  final String successMessage;
  final Future<void> Function(LiveModerationController controller) action;

  /// Runs after a successful command, to re-read the affected list. Awaited so
  /// a refusal from the re-read cannot be mistaken for the command failing.
  final Future<void> Function()? onDone;

  final String? confirmQuestion;
  final String? confirmLabel;
  final bool destructive;

  @override
  ConsumerState<_RosterCommand> createState() => _RosterCommandState();
}

class _RosterCommandState extends ConsumerState<_RosterCommand> {
  bool _busy = false;

  Future<void> _press() async {
    if (_busy) return;
    final question = widget.confirmQuestion;
    if (question != null) {
      final yes = await confirmLiveAction(
        context,
        question: question,
        confirmLabel: widget.confirmLabel ?? widget.label,
        destructive: widget.destructive,
      );
      if (!yes || !mounted) return;
    }
    // Held before the await: the row may be gone when the answer comes.
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await widget.action(ref.read(liveModerationProvider));
      if (mounted) messenger.toast(widget.successMessage);
      // The server has acted; re-read the authoritative list. The command's
      // own result is never applied here.
      await widget.onDone?.call();
    } on LiveException catch (error) {
      if (mounted) messenger.toast(LiveCopy.commandError(error.code));
    } catch (_) {
      if (mounted) messenger.toast(LiveCopy.commandError(null));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.destructive ? context.colors.error : null;
    final icon = _busy
        ? const ExcludeSemantics(
            child: SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          )
        : Icon(widget.icon, size: 18);
    return OutlinedButton.icon(
      onPressed: _busy ? null : _press,
      icon: icon,
      label: Text(widget.label),
      style: color == null
          ? null
          : OutlinedButton.styleFrom(foregroundColor: color),
    );
  }
}

/// A failed read of the roster, said in a word with a retry — kept small, since
/// the session card above it already carries the live state.
class _RosterError extends StatelessWidget {
  const _RosterError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Row(
        children: [
          Icon(
            Icons.cloud_off_rounded,
            size: 18,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Insets.sm),
          Expanded(
            child: Text(LiveCopy.rosterError, style: context.text.bodyMedium),
          ),
          const SizedBox(width: Insets.sm),
          OutlinedButton(
            onPressed: onRetry,
            child: const Text(LiveCopy.retry),
          ),
        ],
      ),
    );
  }
}

/// The roster's own load-more footer (the attendance footer's shape, kept local
/// to Live): nothing while there is no more, a spinner while a page loads, a
/// button otherwise — its label a retry after a failure.
class _RosterLoadMore extends StatelessWidget {
  const _RosterLoadMore({
    required this.hasMore,
    required this.loadingMore,
    required this.loadMoreFailed,
    required this.onLoadMore,
  });

  final bool hasMore;
  final bool loadingMore;
  final bool loadMoreFailed;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    if (!hasMore) return const SizedBox.shrink();
    if (loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: onLoadMore,
        child: Text(
          loadMoreFailed
              ? LiveCopy.rosterLoadMoreFailed
              : LiveCopy.rosterLoadMore,
        ),
      ),
    );
  }
}
