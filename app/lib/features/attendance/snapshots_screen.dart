import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/attendance.dart';
import 'attendance_copy.dart';
import 'state/attendance_snapshots_controller.dart';
import 'widgets/attendance_states.dart';
import 'widgets/snapshot_views.dart';

/// A community's attendance history: its snapshots, newest first, a page at a
/// time (attendance.md §15.1). Shown to a viewer the server says may see them
/// (`community.attendance.view`); reached only when that doorway is offered,
/// and a denied deep link reads as "not available to you". Historical — it
/// never touches Live, so snapshots stay readable after a session ends.
class AttendanceSnapshotsScreen extends ConsumerWidget {
  const AttendanceSnapshotsScreen({super.key, required this.communityId});

  final String communityId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = attendanceSnapshotsProvider(communityId);
    final value = ref.watch(provider);
    return AppScreen(
      title: AttendanceCopy.snapshotsTitle,
      actions: [
        IconButton(
          tooltip: AttendanceCopy.refresh,
          onPressed: () => ref.read(provider.notifier).refresh(),
          icon: const Icon(Icons.refresh_rounded),
        ),
        const SizedBox(width: Insets.sm),
      ],
      slivers: value.when(
        loading: () => const [SliverGutter(top: Insets.lg, child: _Skeleton())],
        error: (error, _) => [
          SliverGutter(
            top: Insets.lg,
            child: AttendanceErrorView(
              code: error is AttendanceException ? error.code : null,
              onRetry: () => ref.invalidate(provider),
            ),
          ),
        ],
        data: (state) => _list(context, ref, state),
      ),
    );
  }

  List<Widget> _list(
    BuildContext context,
    WidgetRef ref,
    AttendanceSnapshotsState state,
  ) {
    if (state.items.isEmpty) {
      return const [
        SliverGutter(
          top: Insets.lg,
          child: EmptyState(
            icon: Icons.fact_check_outlined,
            title: AttendanceCopy.snapshotsEmpty,
            message: AttendanceCopy.snapshotsEmptyMessage,
          ),
        ),
      ];
    }
    return [
      if (state.items.first.origin.isMock)
        const SliverGutter(
          top: Insets.lg,
          child: MockBanner(message: AttendanceCopy.viewingDemoBanner),
        ),
      SliverPadding(
        padding: const EdgeInsets.only(top: Insets.md),
        sliver: SliverList.builder(
          itemCount: state.items.length,
          itemBuilder: (context, index) {
            final snapshot = state.items[index];
            return ResponsiveBody(
              child: Padding(
                padding: const EdgeInsets.only(bottom: Insets.sm),
                child: SnapshotTile(
                  key: ValueKey(snapshot.id),
                  snapshot: snapshot,
                  onTap: () => context.push(
                    Routes.communityAttendanceSnapshot(
                      communityId,
                      snapshot.id,
                    ),
                  ),
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
          onLoadMore: () => _notifier(ref).loadMore(),
        ),
      ),
    ];
  }

  AttendanceSnapshotsController _notifier(WidgetRef ref) =>
      ref.read(attendanceSnapshotsProvider(communityId).notifier);
}

class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
      children: [
        SkeletonBox(height: 84),
        SizedBox(height: Insets.md),
        SkeletonBox(height: 84),
        SizedBox(height: Insets.md),
        SkeletonBox(height: 84),
      ],
    );
  }
}
