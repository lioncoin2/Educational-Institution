import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/attendance.dart';
import 'attendance_copy.dart';
import 'state/attendance_snapshot_detail_controller.dart';
import 'widgets/attendance_states.dart';
import 'widgets/snapshot_views.dart';

/// The participant filter the user can pick. A non-null value for each, because
/// a `PopupMenuButton` reads a `null` selection as a cancel; `all` maps to the
/// repository's `null` connection (every participant).
enum _ParticipantFilter { all, connected, connecting }

SnapshotConnection? _connectionOf(_ParticipantFilter filter) => switch (filter) {
  _ParticipantFilter.all => null,
  _ParticipantFilter.connected => SnapshotConnection.connected,
  _ParticipantFilter.connecting => SnapshotConnection.connecting,
};

/// One attendance snapshot: its header (the two connection counts, who
/// recorded it and when) over its participants, a page at a time (§15.1). Read
/// by snapshot id, authoritative on its own — it never touches Live, so a past
/// session's snapshot stays readable. Names are the server's; a participant
/// without one shows a neutral fallback, never an account id.
///
/// The participants can be narrowed by connection (§17): the filter forwards to
/// the server, which decides the list; the header counts are the snapshot's own
/// and never change with the filter.
class AttendanceSnapshotDetailScreen extends ConsumerStatefulWidget {
  const AttendanceSnapshotDetailScreen({super.key, required this.snapshotId});

  final String snapshotId;

  @override
  ConsumerState<AttendanceSnapshotDetailScreen> createState() =>
      _AttendanceSnapshotDetailScreenState();
}

class _AttendanceSnapshotDetailScreenState
    extends ConsumerState<AttendanceSnapshotDetailScreen> {
  _ParticipantFilter _filter = _ParticipantFilter.all;

  AttendanceParticipantsQuery get _query =>
      (snapshotId: widget.snapshotId, connection: _connectionOf(_filter));

  @override
  Widget build(BuildContext context) {
    final header = ref.watch(attendanceSnapshotProvider(widget.snapshotId));
    final participants = ref.watch(attendanceParticipantsProvider(_query));
    return AppScreen(
      title: AttendanceCopy.detailTitle,
      actions: [
        PopupMenuButton<_ParticipantFilter>(
          tooltip: AttendanceCopy.connectionFilterTooltip,
          icon: const Icon(Icons.filter_list_rounded),
          initialValue: _filter,
          onSelected: (value) => setState(() => _filter = value),
          itemBuilder: (context) => [
            const PopupMenuItem(
              value: _ParticipantFilter.all,
              child: Text(AttendanceCopy.filterAll),
            ),
            PopupMenuItem(
              value: _ParticipantFilter.connected,
              child: Text(
                AttendanceCopy.connectionState(SnapshotConnection.connected),
              ),
            ),
            PopupMenuItem(
              value: _ParticipantFilter.connecting,
              child: Text(
                AttendanceCopy.connectionState(SnapshotConnection.connecting),
              ),
            ),
          ],
        ),
        IconButton(
          tooltip: AttendanceCopy.refresh,
          onPressed: () {
            ref.invalidate(attendanceSnapshotProvider(widget.snapshotId));
            ref.read(attendanceParticipantsProvider(_query).notifier).refresh();
          },
          icon: const Icon(Icons.refresh_rounded),
        ),
        const SizedBox(width: Insets.sm),
      ],
      slivers: [
        SliverGutter(top: Insets.lg, child: _header(header)),
        const SliverGutter(
          top: Insets.xxl,
          child: SectionHeader(title: AttendanceCopy.participantsSection),
        ),
        ..._participants(participants),
      ],
    );
  }

  Widget _header(AsyncValue<SnapshotView> value) => value.when(
    loading: () => const SkeletonBox(height: 140),
    error: (error, _) => AttendanceErrorView(
      code: error is AttendanceException ? error.code : null,
      onRetry: () =>
          ref.invalidate(attendanceSnapshotProvider(widget.snapshotId)),
    ),
    data: (snapshot) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (snapshot.origin.isMock) ...[
          const MockBanner(message: AttendanceCopy.viewingDemoBanner),
          const SizedBox(height: Insets.lg),
        ],
        SnapshotHeaderCard(snapshot: snapshot),
      ],
    ),
  );

  List<Widget> _participants(AsyncValue<AttendanceParticipantsState> value) =>
      value.when(
        loading: () => const [
          SliverGutter(top: Insets.md, child: SkeletonBox(height: 56)),
        ],
        error: (error, _) => [
          SliverGutter(
            top: Insets.md,
            child: AttendanceErrorView(
              code: error is AttendanceException ? error.code : null,
              onRetry: () =>
                  ref.invalidate(attendanceParticipantsProvider(_query)),
            ),
          ),
        ],
        data: (state) {
          if (state.items.isEmpty) {
            return const [
              SliverGutter(
                top: Insets.md,
                child: EmptyState(
                  icon: Icons.group_outlined,
                  title: AttendanceCopy.participantsEmpty,
                ),
              ),
            ];
          }
          return [
            SliverPadding(
              padding: const EdgeInsets.only(top: Insets.md),
              sliver: SliverList.builder(
                itemCount: state.items.length,
                itemBuilder: (context, index) {
                  final participant = state.items[index];
                  return ResponsiveBody(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: Insets.sm),
                      child: ParticipantTile(
                        key: ValueKey(participant.userId),
                        participant: participant,
                      ),
                    ),
                  );
                },
              ),
            ),
            SliverGutter(
              child: LoadMoreFooter(
                hasMore: state.hasMore,
                loadingMore: state.loadingMore,
                loadMoreFailed: state.loadMoreFailed,
                onLoadMore: () => ref
                    .read(attendanceParticipantsProvider(_query).notifier)
                    .loadMore(),
              ),
            ),
          ];
        },
      );
}
