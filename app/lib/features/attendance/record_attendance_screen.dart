import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/communities.dart';
import '../../data/models/live.dart';
import '../communities/state/community_controller.dart';
import '../live/state/live_session_controller.dart';
import 'attendance_copy.dart';
import 'state/record_attendance_controller.dart';
import 'widgets/attendance_states.dart';

/// Record a live session's attendance snapshot (attendance.md §17, P9).
///
/// The screen consumes the Live abstraction — `liveSessionProvider`, which
/// reads `LiveRepository.currentSession` — to know whether a session is
/// running and whether the viewer moderates it, and the community's `me` to
/// know whether they hold the record capability. It never joins, hears or
/// shows any media (that is a separate seam, not this screen's concern), and
/// never reads an account's roles or permissions.
///
/// The Record button appears only when the server says so:
/// `(me.has(attendanceRecord) || liveSession.me.canModerate) && isLive`. That
/// gate is UX only — the backend re-decides on the POST and is the final
/// authority.
class RecordAttendanceScreen extends ConsumerWidget {
  const RecordAttendanceScreen({super.key, required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final liveProvider = liveSessionProvider(communityId);
    final liveValue = ref.watch(liveProvider);
    // The community's own answer about whether the viewer may record here.
    // Read apart from the live session so loading the session is not blocked
    // on it; while the community is still loading this is simply false, and a
    // session moderator is still offered the button by `canModerate` below.
    final allowedByCapability = ref.watch(
      communityProvider(communityId).select(
        (state) =>
            state.value?.community?.me.has(
              CommunityCapability.attendanceRecord,
            ) ??
            false,
      ),
    );

    return AppScreen(
      title: AttendanceCopy.title,
      actions: [
        IconButton(
          tooltip: AttendanceCopy.refresh,
          onPressed: () => ref.invalidate(liveProvider),
          icon: const Icon(Icons.refresh_rounded),
        ),
        const SizedBox(width: Insets.sm),
      ],
      slivers: [
        SliverGutter(
          top: Insets.lg,
          child: AsyncView(
            value: liveValue,
            loading: const _SessionLoading(),
            onRetry: () => ref.invalidate(liveProvider),
            builder: (context, session) {
              if (session == null) {
                return const EmptyState(
                  icon: Icons.podcasts_outlined,
                  title: AttendanceCopy.noSession,
                  message: AttendanceCopy.noSessionMessage,
                );
              }
              return _RecordPanel(
                communityId: communityId,
                session: session,
                allowedByCapability: allowedByCapability,
              );
            },
          ),
        ),
      ],
    );
  }
}

class _SessionLoading extends StatelessWidget {
  const _SessionLoading();

  @override
  Widget build(BuildContext context) {
    return const Column(
      children: [
        SkeletonBox(height: 72),
        SizedBox(height: Insets.lg),
        SkeletonBox(height: 120),
      ],
    );
  }
}

/// The record area for a running session: the live-now context, then — gated
/// on the server's answers — the Record action, a "not running" note, or a
/// "you cannot record here" note.
class _RecordPanel extends ConsumerWidget {
  const _RecordPanel({
    required this.communityId,
    required this.session,
    required this.allowedByCapability,
  });

  final String communityId;
  final LiveSession session;
  final bool allowedByCapability;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mayRecord = allowedByCapability || session.me.canModerate;
    final recordState = ref.watch(recordAttendanceProvider(communityId));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (session.origin.isMock) ...[
          const MockBanner(message: AttendanceCopy.demoBanner),
          const SizedBox(height: Insets.lg),
        ],
        AppCard(
          child: Row(
            children: [
              Icon(
                Icons.podcasts_rounded,
                size: 20,
                color: context.colors.primary,
              ),
              const SizedBox(width: Insets.sm),
              Text(AttendanceCopy.liveNow, style: context.text.titleMedium),
            ],
          ),
        ),
        const SizedBox(height: Insets.xxl),
        if (!session.isLive)
          const _Note(
            icon: Icons.podcasts_outlined,
            text: AttendanceCopy.sessionNotLive,
          )
        else if (!mayRecord)
          const _Note(
            icon: Icons.info_outline_rounded,
            text: AttendanceCopy.cannotRecordMessage,
          )
        else
          _RecordAction(
            state: recordState,
            onRecord: () => ref
                .read(recordAttendanceProvider(communityId).notifier)
                .record(session.id),
          ),
      ],
    );
  }
}

/// The record action, by where the press stands. Idle and failure show a
/// button that presses (failure reuses the same key); in flight it is disabled
/// and busy; success shows the counts and offers a fresh press.
class _RecordAction extends StatelessWidget {
  const _RecordAction({required this.state, required this.onRecord});

  final RecordAttendanceState state;
  final VoidCallback onRecord;

  @override
  Widget build(BuildContext context) => switch (state) {
    RecordIdle() => FilledButton.icon(
      onPressed: onRecord,
      icon: const Icon(Icons.fact_check_outlined),
      label: const Text(AttendanceCopy.recordButton),
    ),
    RecordInFlight() => FilledButton.icon(
      onPressed: null,
      icon: const SizedBox(
        width: 18,
        height: 18,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
      label: const Text(AttendanceCopy.recording),
    ),
    RecordSuccess(:final snapshot) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        RecordResultCard(snapshot: snapshot),
        const SizedBox(height: Insets.lg),
        OutlinedButton.icon(
          onPressed: onRecord,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text(AttendanceCopy.recordAgain),
        ),
      ],
    ),
    RecordFailure(:final code) => AttendanceErrorView(
      code: code,
      onRetry: onRecord,
    ),
  };
}

/// A short informational card — the session is not running, or the viewer has
/// no basis to record. Stated plainly; the server remains the authority.
class _Note extends StatelessWidget {
  const _Note({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: context.colors.onSurfaceVariant),
          const SizedBox(width: Insets.sm),
          Expanded(child: Text(text, style: context.text.bodyMedium)),
        ],
      ),
    );
  }
}
