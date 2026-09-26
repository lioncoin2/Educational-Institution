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

class CommunityInvitationsState {
  const CommunityInvitationsState({
    this.items = const [],
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
    this.forbidden = false,
    this.gone = false,
    this.creating = false,
    this.revoking = const {},
  });

  /// The pages loaded so far: newest first, every state, each link once —
  /// never a token (the server keeps none to send).
  final List<CommunityInvitation> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  /// The community is the viewer's, its links are not (403).
  final bool forbidden;

  /// The community is not the viewer's (any more) (404).
  final bool gone;

  /// A new link has been asked for and not yet answered.
  final bool creating;

  /// The links whose revocation is on its way.
  final Set<String> revoking;

  bool get hasMore => nextCursor != null;

  CommunityInvitationsState copyWith({
    List<CommunityInvitation>? items,
    String? Function()? nextCursor,
    bool? loadingMore,
    bool? loadMoreFailed,
    bool? creating,
    Set<String>? revoking,
  }) => CommunityInvitationsState(
    items: items ?? this.items,
    nextCursor: nextCursor == null ? this.nextCursor : nextCursor(),
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
    forbidden: forbidden,
    gone: gone,
    creating: creating ?? this.creating,
    revoking: revoking ?? this.revoking,
  );
}

/// A community's invitation links, as those who manage them see them — a
/// page (50) at a time, newest first, only as far as someone asks.
///
/// No frame ever carries a link: the list is read again after each change
/// the viewer makes, and whenever the viewer's own standing may have moved
/// (their access changed, their membership began or ended) or the
/// connection comes (back) up — which also answers whether the links are
/// still theirs to see. One that comes while the first page (or a
/// refresh's) is on its way reads it once more after it lands.
///
/// A new link is one request, never sent again on its own: a lost answer
/// leaves a link nobody saw, which can only be revoked — sending again would
/// make another. Its token is handed to the screen in the answer and kept
/// nowhere here. A revocation is one request per link. What either answers
/// — the link as the server now has it — is shown at once; then the first
/// page is read again, and if that read fails, the answer stays and the
/// screen says it could not be read again. Every first page is numbered as
/// it is asked for, and an answer to one asked for before the server
/// answered a change is dropped and asked for again; a next page asked for
/// before is dropped.
class CommunityInvitationsController
    extends AsyncNotifier<CommunityInvitationsState> {
  CommunityInvitationsController(this.communityId);

  final String communityId;

  Future<void>? _reloading;
  bool _reloadAgain = false;
  bool _reloadAfterLoad = false;
  int _generation = 0;
  int _sent = 0;
  int _marked = 0;

  /// The number of the last first page shown.
  int _landed = 0;

  bool _creating = false;
  final Set<String> _revoking = {};

  @override
  Future<CommunityInvitationsState> build() async {
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
      final CommunityInvitationsState first;
      try {
        first = await _firstPage(repository);
      } on CommunityException {
        if (_stale(sentAt) && built.mounted) continue;
        rethrow;
      }
      if (_stale(sentAt) && built.mounted) continue;
      _landed = sentAt;
      return _withWrites(first);
    }
  }

  /// The next page, appended — one at a time, and never while the first is
  /// on its way. A failure keeps what is shown and offers retry; a page cut
  /// from a first page no longer shown is dropped.
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
      final page = await repository.invitations(
        communityId,
        cursor: current.nextCursor,
      );
      if (!ref.mounted) return;
      final now = state.value ?? current;
      if (generation != _generation) {
        state = AsyncData(now.copyWith(loadingMore: false));
        return;
      }
      final seen = {for (final i in now.items) i.id};
      state = AsyncData(
        now.copyWith(
          items: [
            ...now.items,
            ...page.items.where((i) => !seen.contains(i.id)),
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
            ? _withWrites(const CommunityInvitationsState(forbidden: true))
            : error.isGone
            ? _withWrites(const CommunityInvitationsState(gone: true))
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

  /// The server has just answered a change the viewer made: no page asked
  /// for before now is shown after it, and the first page is read again.
  /// Completes once it has landed: true when it did, false when it failed.
  Future<bool> reconcile() => _readBack();

  /// [reconcile], showing first what the change answered ([confirmed]
  /// applied to what is shown) — under the mark, so no page read before is
  /// shown after it.
  Future<bool> _readBack({
    List<CommunityInvitation> Function(List<CommunityInvitation> shown)?
    confirmed,
  }) {
    final mark = _marked = ++_sent;
    _generation += 1;
    final shown = state.isLoading ? null : state.value;
    if (confirmed != null && shown != null) {
      state = AsyncData(
        shown.copyWith(items: List.unmodifiable(confirmed(shown.items))),
      );
    }
    return _reload().then((_) => _landed > mark);
  }

  /// A new link, on the server's own terms: one request, one at a time, and
  /// never sent again on its own. Done: the answer — the only one that will
  /// ever carry its token — once the list has been read again. Refused: the
  /// community and the list are read again.
  Future<WriteOutcome<CreatedInvitation>> create() async {
    if (_creating || state.isLoading || state.value == null) {
      return const WriteNotSent();
    }
    final owner = ref;
    final container = ref.container;
    final alive = owner.keepAlive();
    _creating = true;
    _showWrites();
    try {
      final CreatedInvitation created;
      try {
        created = await ref
            .read(communityRepositoryProvider)
            .createInvitation(communityId);
      } on CommunityException catch (error) {
        if (answersForTheCommunity(error)) await _reconcile(container);
        return WriteFailed(error);
      }
      // Newest first: the new link heads the list.
      final refreshed =
          !ref.mounted ||
          await _readBack(
            confirmed: (shown) => [
              created.invitation,
              for (final i in shown)
                if (i.id != created.invitation.id) i,
            ],
          );
      return WriteDone(created, refreshed: refreshed);
    } finally {
      _creating = false;
      if (ref.mounted) _showWrites();
      // Only the Ref that took the link lets it go (see [revoke]).
      if (owner.mounted) alive.close();
    }
  }

  /// Revokes one link: one request, one at a time per link. Once answered —
  /// done or refused — the list is read again; a refusal reads the community
  /// again too.
  Future<WriteOutcome<void>> revoke(String invitationId) async {
    if (_revoking.contains(invitationId) ||
        state.isLoading ||
        state.value == null) {
      return const WriteNotSent();
    }
    final owner = ref;
    final container = ref.container;
    final alive = owner.keepAlive();
    _revoking.add(invitationId);
    _showWrites();
    try {
      final CommunityInvitation revoked;
      try {
        revoked = await ref
            .read(communityRepositoryProvider)
            .revokeInvitation(communityId, invitationId);
      } on CommunityException catch (error) {
        if (answersForTheCommunity(error)) await _reconcile(container);
        return WriteFailed(error);
      }
      final refreshed =
          !ref.mounted ||
          await _readBack(
            confirmed: (shown) => [
              for (final i in shown) i.id == revoked.id ? revoked : i,
            ],
          );
      return WriteDone(null, refreshed: refreshed);
    } finally {
      _revoking.remove(invitationId);
      if (ref.mounted) _showWrites();
      // Only the Ref that took the link lets it go: after a rebuild Riverpod
      // has dropped it already, and after a dispose, closing it could only
      // dispose whatever element came after — a screen opened since.
      if (owner.mounted) alive.close();
    }
  }

  /// The links — while this controller is still the one showing them — and
  /// the community and its row in the list, wherever those are open.
  Future<void> _reconcile(ProviderContainer container) => Future.wait([
    if (ref.mounted) reconcile(),
    reconcileCommunity(container, communityId),
  ]);

  void _showWrites() {
    final current = state.isLoading ? null : state.value;
    if (current == null) return; // build() carries them when it lands
    state = AsyncData(_withWrites(current));
  }

  CommunityInvitationsState _withWrites(CommunityInvitationsState next) =>
      next.copyWith(creating: _creating, revoking: Set.unmodifiable(_revoking));

  bool _stale(int sentAt) => _marked > sentAt;

  Future<CommunityInvitationsState> _firstPage(
    CommunityRepository repository,
  ) async {
    try {
      final page = await repository.invitations(communityId);
      return CommunityInvitationsState(
        items: page.items,
        nextCursor: page.nextCursor,
      );
    } on CommunityException catch (error) {
      if (error.isForbidden) {
        return const CommunityInvitationsState(forbidden: true);
      }
      if (error.isGone) return const CommunityInvitationsState(gone: true);
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

  /// The first page again, replacing what is shown. One at a time, re-run
  /// once if asked for meanwhile; a failure other than a refusal keeps what
  /// is shown, and an answer to a page asked for before the server last
  /// answered a change is dropped and asked for again.
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
      if (state.value == null) return; // Failed: a retry reads anew.
      final sentAt = ++_sent;
      final CommunityInvitationsState next;
      try {
        next = await _firstPage(ref.read(communityRepositoryProvider));
      } on CommunityException {
        if (!ref.mounted) return;
        if (_stale(sentAt)) _reloadAgain = true;
        continue;
      }
      if (!ref.mounted) return;
      if (_stale(sentAt)) {
        _reloadAgain = true;
        continue;
      }
      _landed = sentAt;
      _generation += 1;
      state = AsyncData(
        _withWrites(next.copyWith(loadingMore: state.value?.loadingMore)),
      );
    } while (_reloadAgain && ref.mounted);
  }
}

final communityInvitationsProvider = AsyncNotifierProvider.autoDispose
    .family<CommunityInvitationsController, CommunityInvitationsState, String>(
      CommunityInvitationsController.new,
      retry: (_, _) => null,
    );
