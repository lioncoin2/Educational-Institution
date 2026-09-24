import 'dart:async';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/communities.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../providers/app_providers.dart';
import 'community_viewer.dart';

class CommunityListState {
  const CommunityListState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  /// Most recently joined first, as the server orders them; each once.
  final List<Community> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  CommunityListState copyWith({
    List<Community>? items,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => CommunityListState(
    items: items ?? this.items,
    nextCursor: nextCursor,
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
  );
}

/// The viewer's communities, a page at a time — kept current by the live
/// connection while the list is open. Every frame is a reason to ask the
/// server, never an answer in itself:
///
///   community.member.added    (the viewer) the first page again
///   community.member.removed  (the viewer) the community leaves the list at
///                             once — then the first page again, so a frame
///                             the server has since overtaken is undone
///   community.locked /        newer than the shown lifecycle version: that
///   community.unlocked        community again (gone: it leaves the list);
///                             an older or repeated one changes nothing
///   community.access.changed  that community again
///
/// Whenever the connection comes (back) up, the first page is fetched again:
/// whatever happened while it was down is in there. Every read runs one at a
/// time and re-runs once if asked for meanwhile, so the last answer shown is
/// always one asked for after the last frame.
class CommunityListController extends AsyncNotifier<CommunityListState> {
  Future<void>? _resyncing;
  bool _resyncAgain = false;
  final Map<String, Future<void>> _refetching = {};
  final Set<String> _refetchAgain = {};

  /// The newest lifecycle version a frame announced, per community — so a
  /// frame older than one already acted on is dropped, even before the read
  /// it started has answered.
  final Map<String, int> _lifecycleSeen = {};

  @override
  Future<CommunityListState> build() async {
    final repository = ref.watch(communityRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });
    final page = await repository.communities();
    return CommunityListState(items: page.items, nextCursor: page.nextCursor);
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
      final page = await repository.communities(cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final c in now.items) c.id};
      state = AsyncData(
        CommunityListState(
          items: [
            ...now.items,
            ...page.items.where((c) => !seen.contains(c.id)),
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } on CommunityException {
      if (!ref.mounted) return;
      state = AsyncData(
        (state.value ?? current).copyWith(
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

  // ── The live connection ─────────────────────────────────────────────────

  void _onEvent(RealtimeEvent event) {
    if (event is! CommunityEvent) return;
    final current = state.value;
    if (current == null) return; // Loading: the first page covers it.
    final shown = current.items
        .where((c) => c.id == event.communityId)
        .firstOrNull;
    switch (event) {
      case CommunityMemberAddedEvent() when concernsViewer(ref, event.userId):
        unawaited(_resync());
      case CommunityMemberRemovedEvent() when concernsViewer(ref, event.userId):
        if (shown != null) {
          state = AsyncData(
            current.copyWith(
              items: [
                for (final c in current.items)
                  if (c.id != event.communityId) c,
              ],
            ),
          );
        }
        unawaited(_resync());
      case CommunityLifecycleEvent(:final communityId, :final lifecycleVersion):
        if (shown == null) return;
        final known = max(
          shown.lifecycleVersion,
          _lifecycleSeen[communityId] ?? 0,
        );
        if (lifecycleVersion <= known) return;
        _lifecycleSeen[communityId] = lifecycleVersion;
        unawaited(_refetch(communityId));
      case CommunityAccessChangedEvent(:final communityId):
        if (shown != null) unawaited(_refetch(communityId));
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(_resync());
  }

  /// The first page again, quietly — no spinner over what is shown. A
  /// failure keeps what is shown.
  Future<void> _resync() {
    final running = _resyncing;
    if (running != null) {
      _resyncAgain = true;
      return running;
    }
    return _resyncing = _runResync().whenComplete(() => _resyncing = null);
  }

  Future<void> _runResync() async {
    do {
      _resyncAgain = false;
      if (state.value == null) return; // Still loading: build fetches anyway.
      final CommunityPage page;
      try {
        page = await ref.read(communityRepositoryProvider).communities();
      } on CommunityException {
        continue; // Keeps what is shown; asked for again meanwhile, retries.
      }
      if (!ref.mounted) return;
      final current = state.value;
      if (current == null) return;
      state = AsyncData(
        CommunityListState(
          items: [
            for (final fetched in page.items)
              _newer(
                current.items.where((c) => c.id == fetched.id).firstOrNull,
                fetched,
              ),
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } while (_resyncAgain && ref.mounted);
  }

  /// One community again (GET /communities/:id), replacing what is shown —
  /// or removing it, when the server says it is not the viewer's any more.
  Future<void> _refetch(String communityId) {
    final running = _refetching[communityId];
    if (running != null) {
      _refetchAgain.add(communityId);
      return running;
    }
    return _refetching[communityId] = _runRefetch(communityId)
        .whenComplete(() => _refetching.remove(communityId));
  }

  Future<void> _runRefetch(String communityId) async {
    do {
      _refetchAgain.remove(communityId);
      Community? fresh;
      try {
        fresh = await ref
            .read(communityRepositoryProvider)
            .community(communityId);
      } on CommunityException catch (error) {
        // Anything but "not found" keeps what is shown.
        if (!error.isGone) continue;
      }
      if (!ref.mounted) return;
      final current = state.value;
      if (current == null) return;
      state = AsyncData(
        current.copyWith(
          items: [
            for (final c in current.items)
              if (c.id != communityId)
                c
              else if (fresh != null)
                _newer(c, fresh),
          ],
        ),
      );
    } while (_refetchAgain.contains(communityId) && ref.mounted);
  }

  /// The server's newer word: [fetched], unless what is shown already
  /// reflects a later lock or unlock than the read that produced it.
  static Community _newer(Community? shown, Community fetched) =>
      shown != null && shown.lifecycleVersion > fetched.lifecycleVersion
      ? shown
      : fetched;
}

final communityListProvider =
    AsyncNotifierProvider.autoDispose<
      CommunityListController,
      CommunityListState
    >(
      CommunityListController.new,
      // Failures surface at once with a retry button; no silent backoff.
      retry: (_, _) => null,
    );
