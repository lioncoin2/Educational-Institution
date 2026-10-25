import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/live.dart';
import '../../../providers/app_providers.dart';

/// Which session's hands to read, and through which filter. A record so each
/// (session, filter) pair is its own keyset-paged view: a `null` [state] is the
/// server's default — the pending queue only, NOT the granted speakers — and a
/// set one names that side ([LiveRepository.hands]); a view of both reads both.
/// Records compare by value, so Riverpod
/// caches one controller per pair and switching the filter reads a fresh first
/// page rather than mutating the current one.
typedef LiveHandsQuery = ({String sessionId, LiveHandsFilter? state});

/// The pages of a session's hands loaded so far, and where it stands.
class LiveHandsState {
  const LiveHandsState({
    this.items = const [],
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  /// In the server's order; each hand once (deduped by its request id).
  final List<LiveHand> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  LiveHandsState copyWith({
    List<LiveHand>? items,
    String? Function()? nextCursor,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => LiveHandsState(
    items: items ?? this.items,
    nextCursor: nextCursor == null ? this.nextCursor : nextCursor(),
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
  );
}

/// A session's hands — the moderator's queue of raised hands and granted
/// speakers — one server page at a time (§12), keyset on an opaque cursor.
/// Immutable and non-realtime like the attendance participant list: the first
/// page loads on build, [loadMore] appends (deduped by request id), and
/// [refresh] re-reads from scratch. A moderator command re-reads it rather than
/// fabricating the new list; the server is the authority. The
/// [LiveHandsQuery.state] filter is forwarded to the server, which decides the
/// page. Reading the queue needs moderator standing — the server refuses a
/// caller who may not, surfaced as a [LiveException]; the screen shows this list
/// only when the session's own `me.canModerate` already allows it.
class LiveHandsController extends AsyncNotifier<LiveHandsState> {
  LiveHandsController(this.query);

  final LiveHandsQuery query;

  @override
  Future<LiveHandsState> build() async {
    // A different signed-in viewer is a different answer: re-read on account
    // change, the live and attendance controllers' convention.
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    final page = await ref
        .read(liveRepositoryProvider)
        .hands(query.sessionId, state: query.state);
    return LiveHandsState(items: page.items, nextCursor: page.nextCursor);
  }

  /// The next page, appended — one at a time. A failure keeps what is shown and
  /// offers a retry.
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
          .read(liveRepositoryProvider)
          .hands(query.sessionId, state: query.state, cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final h in now.items) h.id};
      state = AsyncData(
        now.copyWith(
          items: [
            ...now.items,
            ...page.items.where((h) => !seen.contains(h.id)),
          ],
          nextCursor: () => page.nextCursor,
          loadingMore: false,
        ),
      );
    } on LiveException {
      if (!ref.mounted) return;
      final now = state.value ?? current;
      state = AsyncData(now.copyWith(loadingMore: false, loadMoreFailed: true));
    }
  }

  /// Re-reads the first page again, from scratch — the authority after a
  /// moderator command (a kick, a presenter grant or its revocation), since the
  /// queue has no realtime feed of its own in this build.
  Future<void> refresh() {
    ref.invalidateSelf();
    return future.then<void>((_) {}, onError: (Object _) {});
  }
}

final liveHandsProvider = AsyncNotifierProvider.autoDispose
    .family<LiveHandsController, LiveHandsState, LiveHandsQuery>(
      LiveHandsController.new,
      retry: (_, _) => null,
    );
