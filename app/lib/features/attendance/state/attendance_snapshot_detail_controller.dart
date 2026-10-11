import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/attendance.dart';
import '../../../providers/app_providers.dart';

/// One snapshot's header (counts only), by its id — a single read (§15.1).
/// Refreshed by invalidating; autoDispose so it is released when the detail
/// screen is left. Reads never touch Live, so an ended session's snapshot
/// stays readable. The header is the snapshot's own recorded counts and is not
/// narrowed by the participant filter below.
final attendanceSnapshotProvider = FutureProvider.autoDispose
    .family<SnapshotView, String>(
      (ref, snapshotId) =>
          ref.watch(attendanceRepositoryProvider).snapshot(snapshotId),
      retry: (_, _) => null,
    );

/// Which snapshot's participants to read, and through which connection filter.
/// A record so each (snapshot, filter) pair is its own keyset-paged view: a
/// `null` connection is every participant, a set one narrows to that state
/// (`AttendanceRepository.participants`, §15.1/§17). Records compare by value,
/// so Riverpod caches one controller per pair and switching the filter reads a
/// fresh first page rather than mutating the current one.
typedef AttendanceParticipantsQuery = ({
  String snapshotId,
  SnapshotConnection? connection,
});

/// The pages of a snapshot's participants loaded so far, and where it stands.
class AttendanceParticipantsState {
  const AttendanceParticipantsState({
    this.items = const [],
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  /// Ascending by account id, in the server's order; each participant once.
  final List<SnapshotParticipant> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  AttendanceParticipantsState copyWith({
    List<SnapshotParticipant>? items,
    String? Function()? nextCursor,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => AttendanceParticipantsState(
    items: items ?? this.items,
    nextCursor: nextCursor == null ? this.nextCursor : nextCursor(),
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
  );
}

/// One snapshot's participants, one server page at a time (§15.1), keyset on
/// the account id. Immutable and non-realtime like the snapshots list: first
/// page on build, [loadMore] appends (deduped by account id), [refresh]
/// reloads. The [AttendanceParticipantsQuery.connection] filter is forwarded to
/// the server, which decides membership; the cursor is the server's, opaque.
class AttendanceParticipantsController
    extends AsyncNotifier<AttendanceParticipantsState> {
  AttendanceParticipantsController(this.query);

  final AttendanceParticipantsQuery query;

  @override
  Future<AttendanceParticipantsState> build() async {
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    final page = await ref
        .read(attendanceRepositoryProvider)
        .participants(query.snapshotId, connection: query.connection);
    return AttendanceParticipantsState(
      items: page.items,
      nextCursor: page.nextCursor,
    );
  }

  /// The next page, appended — one at a time. A failure keeps what is shown
  /// and offers a retry.
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
          .participants(
            query.snapshotId,
            connection: query.connection,
            cursor: current.nextCursor,
          );
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final p in now.items) p.userId};
      state = AsyncData(
        now.copyWith(
          items: [
            ...now.items,
            ...page.items.where((p) => !seen.contains(p.userId)),
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

  /// Reads the first page again, from scratch.
  Future<void> refresh() {
    ref.invalidateSelf();
    return future.then<void>((_) {}, onError: (Object _) {});
  }
}

final attendanceParticipantsProvider = AsyncNotifierProvider.autoDispose
    .family<
      AttendanceParticipantsController,
      AttendanceParticipantsState,
      AttendanceParticipantsQuery
    >(AttendanceParticipantsController.new, retry: (_, _) => null);
