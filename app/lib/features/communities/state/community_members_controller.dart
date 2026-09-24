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

  bool get hasMore => nextCursor != null;

  CommunityMembersState copyWith({
    List<CommunityMember>? items,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => CommunityMembersState(
    items: items ?? this.items,
    nextCursor: nextCursor,
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
    forbidden: forbidden,
    gone: gone,
  );
}

/// A community's roster, one server page (50) at a time, and only as far as
/// someone asks: a 30,000-member community costs what is scrolled through,
/// and nothing here ever walks to the end on its own.
///
/// Seeing the roster is a capability the server may take back at any time.
/// A frame that may have changed it — the viewer's access changed, or their
/// membership began or ended — and every reconnect fetch the first page
/// again, which also answers whether the roster is still theirs to see.
class CommunityMembersController extends AsyncNotifier<CommunityMembersState> {
  CommunityMembersController(this.communityId);

  final String communityId;

  Future<void>? _reloading;
  bool _reloadAgain = false;

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
    return _firstPage(repository);
  }

  /// The next page, appended. A failure keeps what is shown and offers retry.
  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    final repository = ref.read(communityRepositoryProvider);
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
      final seen = {for (final m in now.items) m.userId};
      state = AsyncData(
        CommunityMembersState(
          items: [
            ...now.items,
            ...page.items.where((m) => !seen.contains(m.userId)),
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } on CommunityException catch (error) {
      if (!ref.mounted) return;
      state = AsyncData(
        error.isForbidden
            ? const CommunityMembersState(forbidden: true)
            : error.isGone
            ? const CommunityMembersState(gone: true)
            : (state.value ?? current).copyWith(
                loadingMore: false,
                loadMoreFailed: true,
              ),
      );
    }
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  Future<CommunityMembersState> _firstPage(
    CommunityRepository repository,
  ) async {
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
      if (error.isGone) return const CommunityMembersState(gone: true);
      rethrow;
    }
  }

  void _onEvent(RealtimeEvent event) {
    if (event is! CommunityEvent || event.communityId != communityId) return;
    if (state.value == null) return; // Loading: the first page covers it.
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
  /// than a refusal keeps what is shown.
  Future<void> _reload() {
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
      if (state.value == null) return;
      final CommunityMembersState next;
      try {
        next = await _firstPage(ref.read(communityRepositoryProvider));
      } on CommunityException {
        continue;
      }
      if (!ref.mounted) return;
      state = AsyncData(next);
    } while (_reloadAgain && ref.mounted);
  }
}

final communityMembersProvider = AsyncNotifierProvider.autoDispose
    .family<CommunityMembersController, CommunityMembersState, String>(
      CommunityMembersController.new,
      retry: (_, _) => null,
    );
