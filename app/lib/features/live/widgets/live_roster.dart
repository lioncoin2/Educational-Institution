import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../data/models/live.dart';
import '../../../data/models/live_media.dart';
import '../live_copy.dart';
import '../state/live_hands_controller.dart';
import '../state/live_media_controller.dart';
import '../state/live_moderation_controller.dart';
import '../state/live_session_controller.dart';
import 'live_moderation_actions.dart';
import 'live_participant_avatar.dart';

enum _HandsFilter { all, pending, granted }

/// The hands reads behind a filter. The server answers ONE side per read — the
/// queue (`pending`, also its answer when no state is given) or who holds the
/// floor (`granted`) — so «الكل» reads both: the granted speakers first (at
/// most a handful, unpaged), then the queue. Before, «الكل» sent no state and
/// so showed the queue only: a speaker vanished from it the moment the floor
/// was granted, taking the revoke-floor and screen controls with them.
List<LiveHandsFilter?> _statesOf(_HandsFilter filter) => switch (filter) {
  _HandsFilter.all => const [LiveHandsFilter.granted, null],
  _HandsFilter.pending => const [LiveHandsFilter.pending],
  _HandsFilter.granted => const [LiveHandsFilter.granted],
};

/// The participants list (reference: المشاركون) — shown only when the server's
/// own `me.canModerate` allows it (reading the hands queue needs moderator
/// standing). It renders real speakers/hands as avatar rows with a role chip,
/// a live mic indicator, and the per-person moderator commands; a search and a
/// «المستمعون» section are LOCKED placeholders, because listeners carry no names
/// in this build — never fabricated rows.
class LiveRoster extends ConsumerStatefulWidget {
  const LiveRoster({super.key, required this.session});

  final LiveSession session;

  @override
  ConsumerState<LiveRoster> createState() => _LiveRosterState();
}

class _LiveRosterState extends ConsumerState<LiveRoster> {
  _HandsFilter _filter = _HandsFilter.all;

  List<LiveHandsQuery> get _queries => [
    for (final state in _statesOf(_filter))
      (sessionId: widget.session.id, state: state),
  ];

  void _rereadAll() {
    for (final query in _queries) {
      ref.invalidate(liveHandsProvider(query));
    }
  }

  Future<void> _refreshAll() => Future.wait([
    for (final query in _queries)
      ref.read(liveHandsProvider(query).notifier).refresh(),
  ]);

  @override
  Widget build(BuildContext context) {
    // The hands queue has no realtime feed of its own, but the session's
    // `stateVersion` already advances on every hand/floor/screen change — the
    // backend relays it as `live.session.changed` to the moderators (coalesced).
    // Re-read the queue when that version advances (and after a realtime
    // reconnect, which re-discovers the session), so a newly-raised hand appears
    // without a manual refresh. No new event or API: this consumes the existing
    // contract. Guarded to a STRICT increase so an equal/older version never
    // re-reads; backend coalescing (≤1 frame per window) plus the provider's own
    // single-flight rebuild keep this from issuing duplicate/concurrent reads.
    ref.listen<int?>(
      liveSessionProvider(
        widget.session.communityId,
      ).select((session) => session.asData?.value?.stateVersion),
      (previous, next) {
        if (next != null && (previous == null || next > previous)) {
          _rereadAll();
        }
      },
    );
    final queries = _queries;
    final reads = [for (final q in queries) ref.watch(liveHandsProvider(q))];
    final failed = reads.any((read) => read.hasError);
    final loading = !failed && reads.any((read) => !read.hasValue);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Header(
          speakerCount: widget.session.speakerCount,
          filter: _filter,
          onFilter: (value) => setState(() => _filter = value),
        ),
        const SizedBox(height: Insets.md),
        const _LockedSearch(),
        const SizedBox(height: Insets.lg),
        Text(LiveCopy.rosterSection, style: context.text.labelLarge),
        const SizedBox(height: Insets.sm),
        if (failed)
          _RosterError(onRetry: _rereadAll)
        else if (loading)
          const SkeletonBox(height: 64)
        else
          ..._rows([for (final read in reads) read.requireValue], queries.last),
        const SizedBox(height: Insets.lg),
        const _LockedListeners(),
      ],
    );
  }

  /// The rows of every side read (each hand once), then — in «الكل» — anyone
  /// presenting without a hand row, and the paging of the last side (the
  /// queue; the granted side is unpaged).
  List<Widget> _rows(List<LiveHandsState> sides, LiveHandsQuery paged) {
    final seen = <String>{};
    final hands = [
      for (final side in sides)
        for (final hand in side.items)
          if (seen.add(hand.id)) hand,
    ];
    final withRow = {for (final hand in hands) hand.userId};
    final presentersWithoutRow = _filter == _HandsFilter.all
        ? [
            for (final userId in widget.session.presenterUserIds)
              if (!withRow.contains(userId) &&
                  userId != widget.session.hostUserId)
                userId,
          ]
        : const <String>[];
    if (hands.isEmpty && presentersWithoutRow.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: Insets.lg),
          child: Text(
            LiveCopy.rosterEmpty,
            style: context.text.bodySmall,
          ),
        ),
      ];
    }
    final last = sides.last;
    return [
      for (final hand in hands) ...[
        _ParticipantRow(
          key: ValueKey(hand.id),
          session: widget.session,
          hand: hand,
          onActed: _refreshAll,
        ),
        const SizedBox(height: Insets.sm),
      ],
      for (final userId in presentersWithoutRow) ...[
        _PresenterRow(
          key: ValueKey('presenter-$userId'),
          session: widget.session,
          userId: userId,
          onActed: _refreshAll,
        ),
        const SizedBox(height: Insets.sm),
      ],
      _RosterLoadMore(
        hasMore: last.hasMore,
        loadingMore: last.loadingMore,
        loadMoreFailed: last.loadMoreFailed,
        onLoadMore: () => ref.read(liveHandsProvider(paged).notifier).loadMore(),
      ),
    ];
  }
}

/// Someone presenting (a delegated screen grant, ADR 0028) who has no hand row
/// — e.g. their floor was revoked or they yielded it while the screen grant
/// stays open (decision 5). Without this row a moderator had no control left
/// to end that screen share. Their name is the media SDK's (moderators see
/// names, Q68), else the neutral fallback.
class _PresenterRow extends ConsumerWidget {
  const _PresenterRow({
    super.key,
    required this.session,
    required this.userId,
    required this.onActed,
  });

  final LiveSession session;
  final String userId;
  final Future<void> Function() onActed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remote = ref.watch(liveRemoteParticipantsProvider).value?[userId];
    final known = remote?.name;
    final name = known != null && known.isNotEmpty
        ? known
        : LiveCopy.participantFallback;
    return Container(
      padding: const EdgeInsets.all(Insets.md),
      decoration: BoxDecoration(
        color: context.colors.surfaceContainer,
        borderRadius: Radii.brMd,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              LiveParticipantAvatar(
                sessionId: session.id,
                userId: userId,
                name: name,
              ),
              const SizedBox(width: Insets.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: context.text.titleSmall),
                    const SizedBox(height: 2),
                    const _RoleChip(
                      isHost: false,
                      isPresenter: true,
                      state: SpeakerRequestState.granted,
                    ),
                  ],
                ),
              ),
              if (remote != null) _MicIndicator(remote: remote),
            ],
          ),
          const SizedBox(height: Insets.md),
          _RosterCommand(
            key: Key('live-revoke-presenter-$userId'),
            label: LiveCopy.revokePresenter,
            icon: Icons.cancel_presentation_outlined,
            successMessage: LiveCopy.revokePresenterDone,
            action: (c) => c.revokePresenter(session.id, userId),
            onDone: onActed,
          ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.speakerCount,
    required this.filter,
    required this.onFilter,
  });

  final int speakerCount;
  final _HandsFilter filter;
  final ValueChanged<_HandsFilter> onFilter;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(Icons.groups_rounded, size: 20, color: context.colors.primary),
        const SizedBox(width: Insets.sm),
        Expanded(
          child: Text(
            LiveCopy.participantsTitle,
            style: context.text.titleMedium,
          ),
        ),
        Text(
          '${LiveCopy.sectionSpeakers}: $speakerCount',
          style: context.text.labelSmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
        PopupMenuButton<_HandsFilter>(
          tooltip: LiveCopy.rosterFilterTooltip,
          icon: const Icon(Icons.filter_list_rounded),
          initialValue: filter,
          onSelected: onFilter,
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
      ],
    );
  }
}

/// The reference's "ابحث عن مشارك" search — not backed (there is no full
/// participant list to search), so it is an inert, locked field.
class _LockedSearch extends StatelessWidget {
  const _LockedSearch();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      enabled: false,
      label: '${LiveCopy.participantsSearch} — ${LiveCopy.soonBadge}',
      child: Opacity(
        opacity: 0.6,
        child: Container(
          padding: const EdgeInsets.symmetric(
            horizontal: Insets.md,
            vertical: Insets.md,
          ),
          decoration: BoxDecoration(
            color: colors.surfaceContainer,
            borderRadius: Radii.brMd,
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Row(
            children: [
              Icon(Icons.search_rounded, size: 18, color: colors.onSurfaceVariant),
              const SizedBox(width: Insets.sm),
              Expanded(
                child: Text(
                  LiveCopy.participantsSearch,
                  style: context.text.bodyMedium,
                ),
              ),
              Icon(Icons.lock_outline, size: 14, color: colors.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}

/// The reference's «المستمعون» section — listeners have no names in this build,
/// so the section header stays in place over an inert placeholder rather than a
/// fabricated list of people.
class _LockedListeners extends StatelessWidget {
  const _LockedListeners();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(LiveCopy.sectionListeners, style: context.text.labelLarge),
            const SizedBox(width: Insets.sm),
            Icon(Icons.lock_outline, size: 14, color: colors.onSurfaceVariant),
          ],
        ),
        const SizedBox(height: Insets.xs),
        Opacity(
          opacity: 0.7,
          child: Text(
            LiveCopy.listenersUnavailable,
            style: context.text.bodySmall,
          ),
        ),
      ],
    );
  }
}

/// One participant: an avatar, their resolved name (or a neutral fallback), a
/// role chip, the live mic/screen indicators the local SDK observes, and the
/// moderator commands. The host is never a command target.
class _ParticipantRow extends ConsumerWidget {
  const _ParticipantRow({
    super.key,
    required this.session,
    required this.hand,
    required this.onActed,
  });

  final LiveSession session;
  final LiveHand hand;
  final Future<void> Function() onActed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final isHost = hand.userId == session.hostUserId;
    final isPresenter = session.presenterUserIds.contains(hand.userId);
    final name = (hand.displayName != null && hand.displayName!.isNotEmpty)
        ? hand.displayName!
        : LiveCopy.participantFallback;
    final remote = ref.watch(liveRemoteParticipantsProvider).value?[hand.userId];

    return Container(
      padding: const EdgeInsets.all(Insets.md),
      decoration: BoxDecoration(
        color: colors.surfaceContainer,
        borderRadius: Radii.brMd,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              LiveParticipantAvatar(
                sessionId: session.id,
                userId: hand.userId,
                name: name,
              ),
              const SizedBox(width: Insets.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: context.text.titleSmall),
                    const SizedBox(height: 2),
                    _RoleChip(
                      isHost: isHost,
                      isPresenter: isPresenter,
                      state: hand.state,
                    ),
                  ],
                ),
              ),
              if (remote != null) _MicIndicator(remote: remote),
            ],
          ),
          if (!isHost) ...[
            const SizedBox(height: Insets.md),
            Wrap(
              spacing: Insets.sm,
              runSpacing: Insets.sm,
              children: [
                if (hand.state == SpeakerRequestState.pending) ...[
                  _RosterCommand(
                    key: Key('live-grant-floor-${hand.id}'),
                    label: LiveCopy.grantFloor,
                    icon: Icons.record_voice_over_outlined,
                    successMessage: LiveCopy.grantFloorDone,
                    action: (c) => c.grantFloor(hand.id),
                    onDone: onActed,
                  ),
                  _RosterCommand(
                    key: Key('live-decline-hand-${hand.id}'),
                    label: LiveCopy.declineHand,
                    icon: Icons.do_not_disturb_on_outlined,
                    successMessage: LiveCopy.declineHandDone,
                    action: (c) => c.declineHand(hand.id),
                    onDone: onActed,
                  ),
                ],
                if (hand.state == SpeakerRequestState.granted)
                  _RosterCommand(
                    key: Key('live-revoke-floor-${hand.id}'),
                    label: LiveCopy.revokeFloor,
                    icon: Icons.voice_over_off_outlined,
                    successMessage: LiveCopy.revokeFloorDone,
                    action: (c) => c.revokeFloor(hand.id),
                    onDone: onActed,
                  ),
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

/// A small chip naming what this person is: host, presenter, or the state of
/// their hand.
class _RoleChip extends StatelessWidget {
  const _RoleChip({
    required this.isHost,
    required this.isPresenter,
    required this.state,
  });

  final bool isHost;
  final bool isPresenter;
  final SpeakerRequestState state;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final (label, bg, fg) = isHost
        ? (LiveCopy.roleHost, colors.secondaryContainer, colors.onSecondaryContainer)
        : isPresenter
            ? (LiveCopy.presenterBadge, colors.secondaryContainer, colors.onSecondaryContainer)
            : state == SpeakerRequestState.granted
                ? (LiveCopy.handGranted, colors.primaryContainer, colors.onPrimaryContainer)
                : (LiveCopy.handPending, colors.surfaceContainerHigh, colors.onSurfaceVariant);
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.sm,
        vertical: Insets.xs,
      ),
      decoration: BoxDecoration(color: bg, borderRadius: Radii.pill),
      child: Text(
        label,
        style: context.text.labelSmall?.copyWith(color: fg),
      ),
    );
  }
}

/// The live mic/screen state the local SDK observes for this member — a
/// publication fact, never a speaking indicator. Keeps the stable keys the
/// chip tests assert.
class _MicIndicator extends StatelessWidget {
  const _MicIndicator({required this.remote});

  final LiveRemoteParticipant remote;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final children = <Widget>[
      if (remote.screenSharing)
        Padding(
          key: Key('live-screen-sharing-${remote.identity}'),
          padding: const EdgeInsets.only(right: Insets.xs),
          child: Icon(Icons.screen_share_rounded, size: 16, color: colors.primary),
        ),
      if (remote.audio == LiveRemoteAudio.live)
        Semantics(
          key: Key('live-audio-on-${remote.identity}'),
          label: LiveCopy.liveAudioOn,
          child: Icon(Icons.mic_rounded, size: 18, color: colors.primary),
        )
      else if (remote.audio == LiveRemoteAudio.muted)
        Semantics(
          key: Key('live-audio-muted-${remote.identity}'),
          label: LiveCopy.liveAudioMuted,
          child: Icon(Icons.mic_off_rounded, size: 18, color: colors.error),
        ),
    ];
    if (children.isEmpty) return const SizedBox.shrink();
    return Row(mainAxisSize: MainAxisSize.min, children: children);
  }
}

/// One per-person moderator command — a compact button that owns its in-flight
/// state, asks before a destructive command, re-reads the roster on success,
/// and says a refusal through the server's code.
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
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await widget.action(ref.read(liveModerationProvider));
      if (mounted) messenger.toast(widget.successMessage);
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

class _RosterError extends StatelessWidget {
  const _RosterError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(
          Icons.cloud_off_rounded,
          size: 18,
          color: context.colors.onSurfaceVariant,
        ),
        const SizedBox(width: Insets.sm),
        Flexible(
          child: Text(
            LiveCopy.rosterError,
            style: context.text.bodyMedium,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: Insets.sm),
        TextButton(onPressed: onRetry, child: const Text(LiveCopy.retry)),
      ],
    );
  }
}

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
