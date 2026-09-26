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
/// always one asked for after the last frame; what comes while the first
/// page (or a refresh's) is on its way asks for it once more after it lands.
/// The first page and a single community are read side by side, and an
/// answer about a community older than the one shown for it is dropped,
/// whichever lands last.
///
/// A change the viewer made on a community's own screens — a lock, a member
/// removed, the community left or joined, handed over — is answered there;
/// once the server has answered, those screens reconcile the list through
/// [reconcileCommunity], [reconcileLeft] or [reconcileJoined]. From then on
/// an answer to a read sent before is dropped for that community, and it is
/// read again: a read answered before the change never shows it undone.
class CommunityListController extends AsyncNotifier<CommunityListState> {
  Future<void>? _resyncing;
  bool _resyncAgain = false;
  final Map<String, Future<void>> _refetching = {};
  final Set<String> _refetchAgain = {};

  /// The first page was asked for while the build's was on its way: it is
  /// fetched once more once that lands.
  bool _resyncAfterLoad = false;

  /// The newest lifecycle version a frame announced, per community — so a
  /// frame older than one already acted on is dropped, even before the read
  /// it started has answered.
  final Map<String, int> _lifecycleSeen = {};

  /// Every read is numbered as it is sent. Per community, the number of the
  /// read whose answer about it — a row, or "not found" — is applied: an
  /// answer from a read sent before that one changes nothing.
  int _sent = 0;
  final Map<String, int> _answeredBy = {};

  /// The number taken when the server last answered a change this app made
  /// to any community: a first page build() asked for before then may show
  /// the list as it was, so it is asked for again.
  int _marked = 0;

  /// Moves on whenever what is shown stops being the pages [loadMore]
  /// extends — the first page replaced, or a community taken out — so a
  /// next page asked for before is dropped rather than spliced on.
  int _generation = 0;

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
    listenSelf((_, next) {
      if (_resyncAfterLoad && next is AsyncData && !next.isLoading) {
        _resyncAfterLoad = false;
        unawaited(_resync());
      }
    });
    final built = ref;
    for (;;) {
      final sentAt = ++_sent;
      final page = await repository.communities();
      if (_marked > sentAt && built.mounted) continue;
      return CommunityListState(items: page.items, nextCursor: page.nextCursor);
    }
  }

  /// A change the viewer made to [communityId] — a lock, a member removed,
  /// the community handed over — was answered by the server: what any read
  /// sent before now says about it is dropped, and it is read again. One not
  /// shown comes with the next first page.
  Future<void> reconcileCommunity(String communityId) {
    _mark(communityId);
    if (state.isLoading) return Future.value(); // build() asks again for it
    final shown = state.value?.items.any((c) => c.id == communityId) ?? false;
    return shown ? _refetch(communityId) : Future.value();
  }

  /// The server confirmed that the viewer left [communityId]: it leaves the
  /// list at once — and a next page on its way, which may still hold it, is
  /// dropped — then the first page is read again.
  Future<void> reconcileLeft(String communityId) {
    _mark(communityId);
    final current = state.isLoading ? null : state.value;
    if (current != null) {
      _generation += 1;
      state = AsyncData(
        current.copyWith(
          items: [
            for (final c in current.items)
              if (c.id != communityId) c,
          ],
        ),
      );
    }
    return _resync();
  }

  /// The viewer joined [communityId] — or was in it already: the first page
  /// again, where it now stands.
  Future<void> reconcileJoined(String communityId) {
    _mark(communityId);
    return _resync();
  }

  /// From now on, an answer about [communityId] from a read sent before is
  /// dropped.
  void _mark(String communityId) {
    _marked = ++_sent;
    _answeredBy[communityId] = _marked;
  }

  /// The next page, appended — one at a time, and never while the first is
  /// on its way. A failure keeps what is shown and offers retry; a page cut
  /// from a list no longer shown is dropped.
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
      final page = await repository.communities(cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      if (generation != _generation) {
        state = AsyncData(now.copyWith(loadingMore: false));
        return;
      }
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
          loadMoreFailed: generation == _generation,
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
    // While a first page is on its way nothing of it is shown to act on:
    // a frame only asks for the first page once more, once it lands.
    final loading = state.isLoading;
    final current = loading ? null : state.value;
    if (current == null && !loading) return; // Failed: a retry reads anew.
    final shown = current?.items
        .where((c) => c.id == event.communityId)
        .firstOrNull;
    switch (event) {
      case CommunityMemberAddedEvent() when concernsViewer(ref, event.userId):
        unawaited(_resync());
      case CommunityMemberRemovedEvent() when concernsViewer(ref, event.userId):
        // Out at once — of a next page on its way, too.
        _generation += 1;
        if (current != null && shown != null) {
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
      case CommunityLifecycleEvent() || CommunityAccessChangedEvent()
          when loading:
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
  /// failure keeps what is shown. Asked for while the build's first page is
  /// on its way, it runs once that lands.
  Future<void> _resync() {
    if (state.isLoading) {
      _resyncAfterLoad = true;
      return Future.value();
    }
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
      if (state.value == null) return; // Failed: a retry reads anew.
      final sentAt = ++_sent;
      final CommunityPage page;
      try {
        page = await ref.read(communityRepositoryProvider).communities();
      } on CommunityException {
        continue; // Keeps what is shown; asked for again meanwhile, retries.
      }
      if (!ref.mounted) return;
      final current = state.value;
      if (current == null) return;
      final shown = {for (final c in current.items) c.id: c};
      final items = <Community>[];
      for (final fetched in page.items) {
        if (_answeredAfter(fetched.id, sentAt)) {
          // A newer read's answer stands: its row, or its "not found".
          final kept = shown[fetched.id];
          if (kept != null) items.add(kept);
        } else {
          _answeredBy[fetched.id] = sentAt;
          items.add(_newer(shown[fetched.id], fetched));
        }
      }
      final fetchedIds = {for (final c in page.items) c.id};
      for (final c in current.items) {
        // A newer read's row stays, though this page does not have it.
        if (!fetchedIds.contains(c.id) && _answeredAfter(c.id, sentAt)) {
          _placeByJoining(items, c);
        }
      }
      _generation += 1;
      state = AsyncData(
        CommunityListState(
          items: items,
          nextCursor: page.nextCursor,
          // A next page on its way stays on its way — to be dropped.
          loadingMore: current.loadingMore,
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
    // A block, not an arrow: `remove` answers the entry — this very future —
    // and whenComplete would wait for it, forever.
    return _refetching[communityId] = _runRefetch(communityId).whenComplete(() {
      _refetching.remove(communityId);
    });
  }

  Future<void> _runRefetch(String communityId) async {
    do {
      _refetchAgain.remove(communityId);
      final sentAt = ++_sent;
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
      if (_answeredAfter(communityId, sentAt)) continue; // Overtaken.
      _answeredBy[communityId] = sentAt;
      if (fresh == null) _generation += 1; // Out — of a next page, too.
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

  /// A read sent after the one numbered [sentAt] has answered about
  /// [communityId] already.
  bool _answeredAfter(String communityId, int sentAt) =>
      (_answeredBy[communityId] ?? 0) > sentAt;

  /// [community] put among [items] where the server orders it: most
  /// recently joined first.
  static void _placeByJoining(List<Community> items, Community community) {
    final joinedAt = community.me.joinedAt;
    final at = joinedAt == null
        ? -1
        : items.indexWhere((c) => c.me.joinedAt?.isBefore(joinedAt) ?? true);
    items.insert(at < 0 ? items.length : at, community);
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
