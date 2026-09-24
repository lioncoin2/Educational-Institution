import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/communities.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';
import 'community_viewer.dart';

class CommunityMembersState {
  const CommunityMembersState({
    this.items = const [],
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
    this.forbidden = false,
    this.gone = false,
    this.removed = false,
  });

  /// The pages loaded so far, in the server's order; each member once.
  final List<CommunityMember> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  /// The community is the viewer's, its roster is not (403).
  final bool forbidden;

  /// The community is not the viewer's (any more) (404).
  final bool gone;

  /// [gone] after the server had answered for the community as the
  /// viewer's — with a roster, or a refusal to show one: they were in it,
  /// and no longer are. A 404 from the start says only "not yours".
  final bool removed;

  bool get hasMore => nextCursor != null;

  CommunityMembersState copyWith({
    List<CommunityMember>? items,
    String? Function()? nextCursor,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => CommunityMembersState(
    items: items ?? this.items,
    nextCursor: nextCursor == null ? this.nextCursor : nextCursor(),
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
    forbidden: forbidden,
    gone: gone,
    removed: removed,
  );
}

/// A community's roster, one server page (50) at a time, and only as far as
/// someone asks: a 30,000-member community costs what is scrolled through,
/// and nothing here ever walks to the end on its own.
///
/// Seeing the roster is a capability the server may take back at any time.
/// A frame that may have changed it — the viewer's access changed, or their
/// membership began or ended — and every reconnect fetch the first page
/// again, which also answers whether the roster is still theirs to see. One
/// that comes while the first page (or a refresh's) is on its way fetches
/// it once more after it lands; a next page asked for before the first was
/// fetched again is dropped.
class CommunityMembersController extends AsyncNotifier<CommunityMembersState> {
  CommunityMembersController(this.communityId);

  final String communityId;

  Future<void>? _reloading;
  bool _reloadAgain = false;

  /// The first page was asked for while the build's was on its way: it is
  /// fetched once more once that lands.
  bool _reloadAfterLoad = false;

  /// Moves on whenever the first page is fetched again, so a next page
  /// asked for before is dropped rather than spliced onto it.
  int _generation = 0;

  @override
  Future<CommunityMembersState> build() async {
    final repository = ref.watch(communityRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });
    listenSelf((_, next) {
      if (_reloadAfterLoad && next is AsyncData && !next.isLoading) {
        _reloadAfterLoad = false;
        unawaited(_reload());
      }
    });
    return _firstPage(repository);
  }

  /// The next page, appended — one at a time, and never while the first is
  /// on its way. A failure keeps what is shown and offers retry; a page cut
  /// from a first page no longer shown is dropped, and never reopens a
  /// roster the server has since closed.
  Future<void> loadMore() async {
    final current = state.value;
    if (current == null ||
        state.isLoading ||
        !current.hasMore ||
        current.loadingMore) {
      return;
    }
    final repository = ref.read(communityRepositoryProvider);
    final generation = _generation;
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await repository.members(
        communityId,
        cursor: current.nextCursor,
      );
      if (!ref.mounted) return;
      final now = state.value ?? current;
      if (generation != _generation) {
        state = AsyncData(now.copyWith(loadingMore: false));
        return;
      }
      final seen = {for (final m in now.items) m.userId};
      state = AsyncData(
        now.copyWith(
          items: [
            ...now.items,
            ...page.items.where((m) => !seen.contains(m.userId)),
          ],
          nextCursor: () => page.nextCursor,
          loadingMore: false,
        ),
      );
    } on CommunityException catch (error) {
      if (!ref.mounted) return;
      final now = state.value ?? current;
      state = AsyncData(
        generation != _generation
            ? now.copyWith(loadingMore: false)
            : error.isForbidden
            ? const CommunityMembersState(forbidden: true)
            : error.isGone
            ? const CommunityMembersState(gone: true, removed: true)
            : now.copyWith(loadingMore: false, loadMoreFailed: true),
      );
    }
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  /// [wasTheirs]: the server has answered for the community as the
  /// viewer's before, so a "not found" now is a removal.
  Future<CommunityMembersState> _firstPage(
    CommunityRepository repository, {
    bool wasTheirs = false,
  }) async {
    try {
      final page = await repository.members(communityId);
      return CommunityMembersState(
        items: page.items,
        nextCursor: page.nextCursor,
      );
    } on CommunityException catch (error) {
      if (error.isForbidden) {
        return const CommunityMembersState(forbidden: true);
      }
      if (error.isGone) {
        return CommunityMembersState(gone: true, removed: wasTheirs);
      }
      rethrow;
    }
  }

  void _onEvent(RealtimeEvent event) {
    if (event is! CommunityEvent || event.communityId != communityId) return;
    switch (event) {
      case CommunityAccessChangedEvent():
        unawaited(_reload());
      case CommunityMemberRemovedEvent(:final userId) ||
              CommunityMemberAddedEvent(:final userId)
          when concernsViewer(ref, userId):
        unawaited(_reload());
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(_reload());
  }

  /// The first page again, replacing what is shown — never the pages after
  /// it. One at a time, re-run once if asked for meanwhile; a failure other
  /// than a refusal keeps what is shown. Asked for while the build's first
  /// page is on its way, it runs once that lands.
  Future<void> _reload() {
    if (state.isLoading) {
      _reloadAfterLoad = true;
      return Future.value();
    }
    final running = _reloading;
    if (running != null) {
      _reloadAgain = true;
      return running;
    }
    return _reloading = _runReload().whenComplete(() => _reloading = null);
  }

  Future<void> _runReload() async {
    do {
      _reloadAgain = false;
      final shown = state.value;
      if (shown == null) return; // Failed: a retry reads anew.
      final CommunityMembersState next;
      try {
        next = await _firstPage(
          ref.read(communityRepositoryProvider),
          wasTheirs: !shown.gone || shown.removed,
        );
      } on CommunityException {
        continue;
      }
      if (!ref.mounted) return;
      _generation += 1;
      // A next page on its way stays on its way — to be dropped.
      state = AsyncData(next.copyWith(loadingMore: state.value?.loadingMore));
    } while (_reloadAgain && ref.mounted);
  }
}

final communityMembersProvider = AsyncNotifierProvider.autoDispose
    .family<CommunityMembersController, CommunityMembersState, String>(
      CommunityMembersController.new,
      retry: (_, _) => null,
    );
