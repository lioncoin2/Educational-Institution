import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/attendance.dart';
import '../../../providers/app_providers.dart';

/// The pages of a community's snapshots loaded so far, and where loading stands.
class AttendanceSnapshotsState {
  const AttendanceSnapshotsState({
    this.items = const [],
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  /// Newest first, in the server's order; each snapshot once.
  final List<SnapshotView> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  AttendanceSnapshotsState copyWith({
    List<SnapshotView>? items,
    String? Function()? nextCursor,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => AttendanceSnapshotsState(
    items: items ?? this.items,
    nextCursor: nextCursor == null ? this.nextCursor : nextCursor(),
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
  );
}

/// A community's attendance snapshots, one server page at a time (§15.1).
///
/// Snapshots are immutable and carry no realtime, so this is deliberately
/// simpler than the roster: load the first page on build, append later pages
/// on [loadMore] (deduped by id, the server's newest-first order kept), and
/// reload the first page on [refresh]. There is no reconcile or write
/// machinery — nothing to reconcile. The cursor is the server's, forwarded as
/// received and never read here. It never consumes Live — a past session's
/// snapshots stay readable (§10/§15.1).
class AttendanceSnapshotsController
    extends AsyncNotifier<AttendanceSnapshotsState> {
  AttendanceSnapshotsController(this.communityId);

  final String communityId;

  @override
  Future<AttendanceSnapshotsState> build() async {
    // A different signed-in viewer is a different answer.
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    final page = await ref
        .read(attendanceRepositoryProvider)
        .snapshots(communityId);
    return AttendanceSnapshotsState(
      items: page.items,
      nextCursor: page.nextCursor,
    );
  }

  /// The next page, appended — one at a time, never while the first is on its
  /// way. A failure keeps what is shown and offers a retry.
  Future<void> loadMore() async {
    final current = state.value;
    if (current == null ||
        state.isLoading ||
        !current.hasMore ||
        current.loadingMore) {
      return;
    }
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await ref
          .read(attendanceRepositoryProvider)
          .snapshots(communityId, cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final s in now.items) s.id};
      state = AsyncData(
        now.copyWith(
          items: [
            ...now.items,
            ...page.items.where((s) => !seen.contains(s.id)),
          ],
          nextCursor: () => page.nextCursor,
          loadingMore: false,
        ),
      );
    } on AttendanceException {
      if (!ref.mounted) return;
      final now = state.value ?? current;
      state = AsyncData(now.copyWith(loadingMore: false, loadMoreFailed: true));
    }
  }

  /// Reads the first page again, from scratch — the old cursor is not reused.
  Future<void> refresh() {
    ref.invalidateSelf();
    return future.then<void>((_) {}, onError: (Object _) {});
  }
}

final attendanceSnapshotsProvider = AsyncNotifierProvider.autoDispose
    .family<AttendanceSnapshotsController, AttendanceSnapshotsState, String>(
      AttendanceSnapshotsController.new,
      retry: (_, _) => null,
    );
