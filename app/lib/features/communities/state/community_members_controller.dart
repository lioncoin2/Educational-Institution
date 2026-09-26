import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/communities.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';
import 'community_reconcile.dart';
import 'community_viewer.dart';
import 'community_write.dart';

/// A change to one member, on its way to the server.
enum MemberWrite { remove, transfer }

class CommunityMembersState {
  const CommunityMembersState({
    this.items = const [],
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
    this.forbidden = false,
    this.gone = false,
    this.removed = false,
    this.writing = const {},
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

  /// By member: the change sent about them and not yet answered — one per
  /// member at a time.
  final Map<String, MemberWrite> writing;

  bool get hasMore => nextCursor != null;

  CommunityMembersState copyWith({
    List<CommunityMember>? items,
    String? Function()? nextCursor,
    bool? loadingMore,
    bool? loadMoreFailed,
    Map<String, MemberWrite>? writing,
  }) => CommunityMembersState(
    items: items ?? this.items,
    nextCursor: nextCursor == null ? this.nextCursor : nextCursor(),
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
    forbidden: forbidden,
    gone: gone,
    removed: removed,
    writing: writing ?? this.writing,
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
///
/// Removing a member and handing the community over are one request each,
/// per member, and the roster changes only once the server has answered —
/// a removed member's row goes at once, the server having confirmed it —
/// then the first page is read again, with the community and its row in the
/// list (a hand-over shows them what it answered first). Every read is
/// numbered as it is sent, and [reconcile] marks the moment an answer came:
/// a first page asked for before it is dropped and asked for again, and a
/// next page asked for before it is dropped — so a page read while a
/// removal was on its way never brings the member back. If the read after a
/// change fails, what the change confirmed stays, and the screen says it
/// could not be read again.
class CommunityMembersController extends AsyncNotifier<CommunityMembersState> {
  CommunityMembersController(this.communityId);

  final String communityId;

  Future<void>? _reloading;
  bool _reloadAgain = false;

  /// The first page was asked for while the build's was on its way: it is
  /// fetched once more once that lands.
  bool _reloadAfterLoad = false;

  /// Moves on whenever the first page is fetched again, or a change is
  /// answered, so a next page asked for before is dropped rather than
  /// spliced on.
  int _generation = 0;

  /// Every first page is numbered as it is asked for; [_marked] is the
  /// number taken when the server last answered a change this app made. An
  /// answer to one numbered below it is dropped. [_landed] is the number of
  /// the last first page shown.
  int _sent = 0;
  int _marked = 0;
  int _landed = 0;

  final Map<String, MemberWrite> _writing = {};

  @override
  Future<CommunityMembersState> build() async {
    // A sign-in, a sign-out or another account is another viewer: read
    // again — not while the session merely resolves to the same one.
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
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
    // A first page is on its way: a next page asked for before is cut from
    // one no longer shown.
    _generation += 1;
    final built = ref;
    for (;;) {
      final sentAt = ++_sent;
      final CommunityMembersState first;
      try {
        first = await _firstPage(repository);
      } on CommunityException {
        if (_stale(sentAt) && built.mounted) continue;
        rethrow;
      }
      if (_stale(sentAt) && built.mounted) continue;
      _landed = sentAt;
      return first.copyWith(writing: Map.unmodifiable(_writing));
    }
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
            ? _withWriting(const CommunityMembersState(forbidden: true))
            : error.isGone
            ? _withWriting(
                const CommunityMembersState(gone: true, removed: true),
              )
            : now.copyWith(loadingMore: false, loadMoreFailed: true),
      );
    }
  }

  /// Reads the first page again at the viewer's request. What is shown
  /// stays shown — and usable, a change on its way included — until it
  /// lands: this is the one-at-a-time, numbered read a confirmed change
  /// uses, and a next page on its way is dropped. Only a screen with nothing
  /// to show (its first read failed) starts over.
  Future<void> refresh() {
    if (state.hasValue) return reconcile().then<void>((_) {});
    ref.invalidateSelf();
    return future.then<void>((_) {}, onError: (Object _) {});
  }

  /// The server has just answered a change the viewer made to this
  /// community: no page asked for before now is shown after it, and the
  /// first page is read again. Completes once it has landed: true when it
  /// did, false when it failed.
  Future<bool> reconcile() => _readBack();

  /// [reconcile], showing first what the change confirmed ([confirmed]
  /// applied to what is shown) — under the mark, so no page read before is
  /// shown after it.
  Future<bool> _readBack({
    CommunityMembersState Function(CommunityMembersState shown)? confirmed,
  }) {
    final mark = _marked = ++_sent;
    _generation += 1;
    final shown = state.isLoading ? null : state.value;
    if (confirmed != null && shown != null) state = AsyncData(confirmed(shown));
    return _reload().then((_) => _landed > mark);
  }

  /// Ends [userId]'s membership: one request, one at a time per member.
  /// Once answered — done or refused — the roster, the community (its
  /// count) and its row in the list are read again; the row's spinner stays
  /// until they are shown.
  Future<WriteOutcome<void>> remove(String userId) =>
      _write(userId, MemberWrite.remove, (repository) async {
        await repository.removeMember(communityId, userId);
        return null;
      });

  /// Hands the community to [userId], as [remove] ends a membership. What
  /// the server answers — the community as the viewer now stands in it — is
  /// shown on the community and in the list at once; then they are read
  /// again, as is the roster, which may no longer be the viewer's to see.
  Future<WriteOutcome<void>> transferOwnership(String userId) => _write(
    userId,
    MemberWrite.transfer,
    (repository) => repository.transferOwnership(communityId, userId),
  );

  /// [send] answers the community as the viewer now stands in it — or null,
  /// for a removal, which answers nothing.
  Future<WriteOutcome<void>> _write(
    String userId,
    MemberWrite write,
    Future<Community?> Function(CommunityRepository repository) send,
  ) async {
    if (_writing.containsKey(userId) ||
        state.isLoading ||
        state.value == null) {
      return const WriteNotSent();
    }
    // Seen through to the end, even if the screen is left meanwhile: what
    // the answer changed is still reconciled — through the container, which
    // outlives this controller.
    final owner = ref;
    final container = ref.container;
    final alive = owner.keepAlive();
    _setWriting(userId, write);
    try {
      final Community? answer;
      try {
        answer = await send(ref.read(communityRepositoryProvider));
      } on CommunityException catch (error) {
        if (answersForTheCommunity(error)) await _reconcile(container);
        return WriteFailed(error);
      }
      final refreshed = await _reconcile(
        container,
        confirmed: answer,
        removed: write == MemberWrite.remove ? userId : null,
      );
      return WriteDone(null, refreshed: refreshed);
    } finally {
      if (ref.mounted) _setWriting(userId, null);
      // Only the Ref that took the link lets it go: after a rebuild Riverpod
      // has dropped it already, and after a dispose, closing it could only
      // dispose whatever element came after — a screen opened since.
      if (owner.mounted) alive.close();
    }
  }

  /// The roster — while this controller is still the one showing it, the
  /// [removed] member's row gone at once — and the community and its row in
  /// the list, wherever those are open, [confirmed] shown first. True unless
  /// this screen's own read after it failed.
  Future<bool> _reconcile(
    ProviderContainer container, {
    Community? confirmed,
    String? removed,
  }) async {
    final results = await Future.wait<bool>([
      if (ref.mounted)
        _readBack(
          confirmed: removed == null
              ? null
              : (shown) => shown.copyWith(
                  items: [
                    for (final m in shown.items)
                      if (m.userId != removed) m,
                  ],
                ),
        ),
      reconcileCommunity(
        container,
        communityId,
        confirmed: confirmed,
      ).then((_) => true),
    ]);
    return !results.contains(false);
  }

  void _setWriting(String userId, MemberWrite? write) {
    if (write == null) {
      _writing.remove(userId);
    } else {
      _writing[userId] = write;
    }
    final current = state.isLoading ? null : state.value;
    if (current == null) return; // build() carries it when it lands
    state = AsyncData(current.copyWith(writing: Map.unmodifiable(_writing)));
  }

  CommunityMembersState _withWriting(CommunityMembersState next) =>
      next.copyWith(writing: Map.unmodifiable(_writing));

  bool _stale(int sentAt) => _marked > sentAt;

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
  /// than a refusal keeps what is shown, and an answer to a page asked for
  /// before the server last answered a change is dropped and asked for
  /// again. Asked for while the build's first page is on its way, it runs
  /// once that lands.
  Future<void> _reload() {
    if (state.isLoading) {
      _reloadAfterLoad = true;
      return future.then<void>((_) {}, onError: (Object _) {});
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
      final sentAt = ++_sent;
      final CommunityMembersState next;
      try {
        next = await _firstPage(
          ref.read(communityRepositoryProvider),
          wasTheirs: !shown.gone || shown.removed,
        );
      } on CommunityException {
        if (!ref.mounted) return;
        if (_stale(sentAt)) _reloadAgain = true;
        continue;
      }
      if (!ref.mounted) return;
      if (_stale(sentAt)) {
        // Asked before the server answered a change: it may not show it.
        _reloadAgain = true;
        continue;
      }
      _landed = sentAt;
      _generation += 1;
      // A next page on its way stays on its way — to be dropped.
      state = AsyncData(
        next.copyWith(
          loadingMore: state.value?.loadingMore,
          writing: Map.unmodifiable(_writing),
        ),
      );
    } while (_reloadAgain && ref.mounted);
  }
}

final communityMembersProvider = AsyncNotifierProvider.autoDispose
    .family<CommunityMembersController, CommunityMembersState, String>(
      CommunityMembersController.new,
      retry: (_, _) => null,
    );
