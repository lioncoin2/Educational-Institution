import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/tasks/tasks.dart';

/// A server-paged list: the first page on build, the next one appended on
/// [loadMore]. Nothing is changed optimistically — a mutation re-reads, so a
/// refusal leaves the last good page in place.
abstract class PagedListController<T> extends AsyncNotifier<TasksPage<T>> {
  /// One page from the server, starting after [cursor].
  Future<TasksPage<T>> fetch(String? cursor);

  bool _loadingMore = false;

  @override
  Future<TasksPage<T>> build() => fetch(null);

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  /// Appends the next page. A failure is rethrown for the caller to report;
  /// the rows already shown stay.
  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || _loadingMore) return;
    _loadingMore = true;
    try {
      final next = await fetch(current.nextCursor);
      if (ref.mounted) state = AsyncData(current.followedBy(next));
    } finally {
      _loadingMore = false;
    }
  }
}
