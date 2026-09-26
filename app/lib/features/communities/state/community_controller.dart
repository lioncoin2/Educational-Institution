import 'dart:async';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/communities.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';
import 'community_list_controller.dart';
import 'community_viewer.dart';
import 'community_write.dart';
import 'membership_reconcile.dart';

/// A change to the community itself, on its way to the server.
enum CommunityWrite { lock, unlock, leave }

class CommunityDetailState {
  const CommunityDetailState({
    this.community,
    this.removed = false,
    this.writing,
  });

  /// The server's last word on the community — kept after a removal, so the
  /// screen can still say which community it was. Null when the server never
  /// showed it (it answered "no such community" from the start).
  final Community? community;

  /// Not the viewer's any more — or never was. Nothing of it is offered.
  final bool removed;

  /// The change sent and not yet answered — one at a time: while it is on
  /// its way, no other is sent.
  final CommunityWrite? writing;
}

/// One community, as the viewer may see it now.
///
/// What the viewer may do is `me` in the server's answer, and it is never
/// worked out here: a frame only says it is time to ask again.
///
///   community.locked /        newer than the lifecycle version held: one
///   community.unlocked        read (a lock changes what `me` allows); an
///                             older or repeated one changes nothing
///   community.access.changed  one read
///   community.member.removed  (the viewer) shown as removed at once, then
///                             one read to confirm: still theirs (the frame
///                             was overtaken) restores it, "not found" keeps
///                             it removed
///   community.member.added    (the viewer) one read
///
/// Whenever the connection comes (back) up it is read again. A frame or a
/// reconnect that comes while the first read (or a refresh's) is on its way
/// waits for it to land, then asks once more: that read may have been
/// answered before the change. A "not found" is the removed state, not an
/// error: the server answers it alike for a community that does not exist
/// and one that is not the viewer's.
///
/// The viewer's own changes — lock, unlock, leave here; a member removed,
/// ownership handed over, a refused link or grant on the community's other
/// screens — are one request each, and what is shown changes only once the
/// server has answered: never before, and never back. Every read is numbered
/// as it is sent, and [reconcile] marks the moment an answer came: a read
/// sent before it may have been answered before the change, so its answer is
/// dropped and the community read again. What a lock, an unlock or a
/// hand-over answers — the community as the server stood when it did the
/// change, not a guess — is shown at once under that mark (a newer lock or
/// unlock already shown stays), so its echo frame finds the version held;
/// then the read after it confirms it, and if that read fails, the answer
/// stays and the screen says it could not be read again.
class CommunityController extends AsyncNotifier<CommunityDetailState> {
  CommunityController(this.communityId);

  final String communityId;

  Future<void>? _reading;
  bool _readAgain = false;

  /// A read was asked for while the build's was on its way: one runs once
  /// that lands.
  bool _readAfterLoad = false;

  /// The newest lifecycle version a frame announced.
  int _lifecycleSeen = 0;

  /// Every read is numbered as it is sent; [_marked] is the number taken
  /// when the server last answered a change this app made. An answer to a
  /// read numbered below it is dropped. [_landed] is the number of the last
  /// read whose answer is shown.
  int _sent = 0;
  int _marked = 0;
  int _landed = 0;

  CommunityWrite? _writing;

  @override
  Future<CommunityDetailState> build() async {
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
      if (_readAfterLoad && next is AsyncData && !next.isLoading) {
        _readAfterLoad = false;
        unawaited(_read());
      }
    });
    final built = ref;
    for (;;) {
      final sentAt = ++_sent;
      try {
        final community = await repository.community(communityId);
        if (_stale(sentAt) && built.mounted) continue;
        _landed = sentAt;
        return CommunityDetailState(community: community, writing: _writing);
      } on CommunityException catch (error) {
        if (_stale(sentAt) && built.mounted) continue;
        if (error.isGone) {
          _landed = sentAt;
          return CommunityDetailState(removed: true, writing: _writing);
        }
        rethrow;
      }
    }
  }

  /// Reads again at the viewer's request. What is shown stays shown — and
  /// usable, a change on its way included — until the answer lands: this is
  /// the one-at-a-time, numbered read a confirmed change uses. Only a screen
  /// with nothing to show (its first read failed) starts over.
  Future<void> refresh() {
    if (state.hasValue) return reconcile().then<void>((_) {});
    ref.invalidateSelf();
    return future.then<void>((_) {}, onError: (Object _) {});
  }

  /// The server has just answered a change the viewer made to this
  /// community — here, or on one of its other screens: no answer to a read
  /// sent before now is shown after it. [confirmed] — what a lock, an unlock
  /// or a hand-over answered: the community as the server stood when it did
  /// the change — is shown at once, unless a newer lock or unlock already
  /// is. Then the community is read again. Completes once that read has
  /// landed: true when it did, false when it failed.
  Future<bool> reconcile({Community? confirmed}) {
    final mark = _marked = ++_sent;
    if (confirmed != null) _showConfirmed(confirmed);
    return _read().then((_) => _landed > mark);
  }

  void _showConfirmed(Community answer) {
    final current = state.isLoading ? null : state.value;
    // Loading: build() reads after the mark. Removed: the read says.
    if (current == null || current.removed) return;
    final shown = current.community;
    if (shown != null && shown.lifecycleVersion > answer.lifecycleVersion) {
      return;
    }
    state = AsyncData(
      CommunityDetailState(community: answer, writing: _writing),
    );
  }

  /// Locks the community: one request. Done, the server's answer is shown
  /// and the community read again — the spinner stays until that read has
  /// landed; refused, the community is read again.
  Future<WriteOutcome<void>> lock() =>
      _write(CommunityWrite.lock, (repository) => repository.lock(communityId));

  /// Unlocks it, as [lock] locks it.
  Future<WriteOutcome<void>> unlock() => _write(
    CommunityWrite.unlock,
    (repository) => repository.unlock(communityId),
  );

  /// Ends the viewer's own membership: one request. Once confirmed the
  /// community is, to the viewer, one that does not exist — it is shown as
  /// removed, and it leaves the list at once. A refusal reads the community
  /// again.
  Future<WriteOutcome<void>> leave() =>
      _write(CommunityWrite.leave, (repository) async {
        await repository.leave(communityId);
        return null;
      });

  /// [send] answers the community as the server now has it — or null, for a
  /// leave, which answers nothing.
  Future<WriteOutcome<void>> _write(
    CommunityWrite write,
    Future<Community?> Function(CommunityRepository repository) send,
  ) async {
    final shown = state.value;
    if (_writing != null ||
        state.isLoading ||
        shown == null ||
        shown.removed ||
        shown.community == null) {
      return const WriteNotSent();
    }
    // Seen through to the end, even if the screen is left meanwhile: what
    // the answer changed is still reconciled — through the container, which
    // outlives this controller.
    final owner = ref;
    final container = ref.container;
    final alive = owner.keepAlive();
    _setWriting(write);
    try {
      final Community? answer;
      try {
        answer = await send(ref.read(communityRepositoryProvider));
      } on CommunityException catch (error) {
        if (answersForTheCommunity(error)) await _reconcileAll(container);
        return WriteFailed(error);
      }
      if (write == CommunityWrite.leave) {
        _left(container);
        return const WriteDone(null);
      }
      return WriteDone(
        null,
        refreshed: await _reconcileAll(container, confirmed: answer),
      );
    } finally {
      if (ref.mounted) _setWriting(null);
      // Only the Ref that took the link lets it go: after a rebuild Riverpod
      // has dropped it already, and after a dispose, closing it could only
      // dispose whatever element came after — a screen opened since.
      if (owner.mounted) alive.close();
    }
  }

  /// The viewer left: shown as removed now — nothing read before is shown
  /// after — and out of the list at once. There is nothing left to read:
  /// to the viewer the community no longer exists.
  void _left(ProviderContainer container) {
    if (ref.mounted) {
      _marked = ++_sent;
      final current = state.value;
      state = AsyncData(
        CommunityDetailState(
          community: current?.community,
          removed: true,
          writing: _writing,
        ),
      );
    }
    if (container.exists(communityListProvider)) {
      unawaited(
        container
            .read(communityListProvider.notifier)
            .reconcileLeft(communityId),
      );
    }
    reconcileMembership(container, communityId, left: true);
  }

  /// This community — while this controller is still the one showing it —
  /// and its row in the list, wherever that is open, each shown as
  /// [confirmed] first when the change answered one. True unless this
  /// screen's own read after it failed.
  Future<bool> _reconcileAll(
    ProviderContainer container, {
    Community? confirmed,
  }) async {
    final results = await Future.wait<bool>([
      if (ref.mounted) reconcile(confirmed: confirmed),
      if (container.exists(communityListProvider))
        container
            .read(communityListProvider.notifier)
            .reconcileCommunity(communityId, confirmed: confirmed)
            .then((_) => true),
    ]);
    return !results.contains(false);
  }

  void _setWriting(CommunityWrite? write) {
    _writing = write;
    final current = state.isLoading ? null : state.value;
    if (current == null) return; // build() carries it when it lands
    state = AsyncData(
      CommunityDetailState(
        community: current.community,
        removed: current.removed,
        writing: write,
      ),
    );
  }

  bool _stale(int sentAt) => _marked > sentAt;

  void _onEvent(RealtimeEvent event) {
    if (event is! CommunityEvent || event.communityId != communityId) return;
    // While the read is on its way nothing of it is shown to act on: a frame
    // only asks for one read more, once it lands.
    final loading = state.isLoading;
    final current = loading ? null : state.value;
    if (current == null && !loading) return; // Failed: a retry reads anew.
    switch (event) {
      case CommunityLifecycleEvent(:final lifecycleVersion):
        final known = max(
          current?.community?.lifecycleVersion ?? 0,
          _lifecycleSeen,
        );
        if (lifecycleVersion <= known) return;
        _lifecycleSeen = lifecycleVersion;
        unawaited(_read());
      case CommunityAccessChangedEvent():
        unawaited(_read());
      case CommunityMemberRemovedEvent() when concernsViewer(ref, event.userId):
        if (current != null && !current.removed) {
          state = AsyncData(
            CommunityDetailState(
              community: current.community,
              removed: true,
              writing: _writing,
            ),
          );
        }
        unawaited(_read());
      case CommunityMemberAddedEvent() when concernsViewer(ref, event.userId):
        unawaited(_read());
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (!status.isLive) return;
    // A first read that failed has nothing to read over: start over.
    if (state.hasError && !state.hasValue) {
      ref.invalidateSelf();
    } else {
      unawaited(_read());
    }
  }

  /// GET /communities/:id again, quietly. One at a time; a read asked for
  /// meanwhile runs once more after it, so the last answer shown was asked
  /// for after the last frame — and one asked for while the build's read is
  /// on its way runs once that lands. An answer to a read sent before the
  /// server last answered a change is dropped, and the community read once
  /// more. A failure other than "not found" keeps what is shown.
  Future<void> _read() {
    if (state.isLoading) {
      _readAfterLoad = true;
      return future.then<void>((_) {}, onError: (Object _) {});
    }
    final running = _reading;
    if (running != null) {
      _readAgain = true;
      return running;
    }
    return _reading = _runRead().whenComplete(() => _reading = null);
  }

  Future<void> _runRead() async {
    do {
      _readAgain = false;
      if (state.value == null) return; // Failed: a retry reads anew.
      final sentAt = ++_sent;
      Community? fresh;
      CommunityException? refusal;
      try {
        fresh = await ref
            .read(communityRepositoryProvider)
            .community(communityId);
      } on CommunityException catch (error) {
        refusal = error;
      }
      if (!ref.mounted) return;
      if (_stale(sentAt)) {
        // Asked before the server answered a change: it may not show it.
        _readAgain = true;
        continue;
      }
      if (fresh != null) {
        _landed = sentAt;
        state = AsyncData(
          CommunityDetailState(community: fresh, writing: _writing),
        );
      } else if (refusal?.isGone ?? false) {
        _landed = sentAt;
        state = AsyncData(
          CommunityDetailState(
            community: state.value?.community,
            removed: true,
            writing: _writing,
          ),
        );
      }
    } while (_readAgain && ref.mounted);
  }
}

final communityProvider = AsyncNotifierProvider.autoDispose
    .family<CommunityController, CommunityDetailState, String>(
      CommunityController.new,
      retry: (_, _) => null,
    );
