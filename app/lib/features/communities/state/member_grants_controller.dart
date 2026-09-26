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

/// Whose grants: one member of one community.
typedef MemberKey = ({String communityId, String userId});

/// A change to a member's grants, on its way to the server.
sealed class GrantWrite {
  const GrantWrite();
}

/// Granting these capabilities, in one request.
final class Granting extends GrantWrite {
  const Granting(this.capabilities);

  final Set<CommunityCapability> capabilities;
}

/// Ending this grant.
final class Revoking extends GrantWrite {
  const Revoking(this.grantId);

  final String grantId;
}

class MemberGrantsState {
  const MemberGrantsState({
    this.grants = const [],
    this.forbidden = false,
    this.gone = false,
    this.writing,
  });

  /// The member's grants as the server lists them to the viewer — one per
  /// capability. For a viewer the server lets manage grants that is every
  /// grant the member holds; this list is the only source of "granted".
  final List<CommunityGrant> grants;

  /// The community is the viewer's, this is not (403).
  final bool forbidden;

  /// The community is not the viewer's (any more) (404).
  final bool gone;

  /// The change sent and not yet answered — one at a time per member.
  final GrantWrite? writing;

  /// The member's grant of [capability], if the server lists one.
  CommunityGrant? grantOf(CommunityCapability capability) =>
      grants.where((g) => g.capability == capability).firstOrNull;

  MemberGrantsState withWriting(GrantWrite? writing) => MemberGrantsState(
    grants: grants,
    forbidden: forbidden,
    gone: gone,
    writing: writing,
  );
}

/// One member's delegated capabilities in one community, as the server lists
/// them — for a viewer it lets manage grants (`me.operations` holds
/// `community.grants.manage`).
///
/// The list is read whole: a member holds at most one grant per capability,
/// so it is a page or two at most. It is read again after each change the
/// viewer makes, whenever the viewer's own standing may have moved (their
/// access changed, their membership began or ended), and whenever the
/// connection comes (back) up — no frame carries another member's grants.
///
/// Granting is one request for every capability chosen; revoking, one per
/// grant; one change at a time for the member, never sent again on its own.
/// What is shown changes only once the server has answered: a read asked
/// for before that answer is dropped and asked for again, and a refusal
/// reads the community again too, so the screen follows the server's `me`.
class MemberGrantsController extends AsyncNotifier<MemberGrantsState> {
  MemberGrantsController(this.member);

  final MemberKey member;

  Future<void>? _reading;
  bool _readAgain = false;
  bool _readAfterLoad = false;
  int _sent = 0;
  int _marked = 0;
  GrantWrite? _writing;

  String get _communityId => member.communityId;

  @override
  Future<MemberGrantsState> build() async {
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
      final MemberGrantsState grants;
      try {
        grants = await _grants(repository);
      } on CommunityException {
        if (_stale(sentAt) && built.mounted) continue;
        rethrow;
      }
      if (_stale(sentAt) && built.mounted) continue;
      return grants.withWriting(_writing);
    }
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  /// The server has just answered a change the viewer made: no read sent
  /// before now is shown after it, and the grants are read again. Completes
  /// once that read has landed.
  Future<void> reconcile() {
    _marked = ++_sent;
    return _read();
  }

  /// Grants [capabilities] to the member: one request for them all.
  /// Answered — done or refused — the grants are read again (a refusal
  /// reads the community too); done carries what was created, and what the
  /// member already held.
  Future<WriteOutcome<GrantChange>> grant(
    Set<CommunityCapability> capabilities,
  ) {
    final chosen = {
      for (final c in capabilities)
        if (c != CommunityCapability.unknown) c,
    };
    if (chosen.isEmpty) return Future.value(const WriteNotSent());
    return _write(
      Granting(Set.unmodifiable(chosen)),
      (repository) => repository.grant(
        _communityId,
        userId: member.userId,
        capabilities: chosen,
      ),
    );
  }

  /// Ends one grant: one request, as [grant] grants.
  Future<WriteOutcome<void>> revoke(String grantId) => _write(
    Revoking(grantId),
    (repository) => repository.revokeGrant(_communityId, grantId),
  );

  Future<WriteOutcome<T>> _write<T>(
    GrantWrite write,
    Future<T> Function(CommunityRepository repository) send,
  ) async {
    if (_writing != null || state.isLoading || state.value == null) {
      return WriteNotSent<T>();
    }
    final alive = ref.keepAlive();
    _setWriting(write);
    try {
      final T answer;
      try {
        answer = await send(ref.read(communityRepositoryProvider));
      } on CommunityException catch (error) {
        if (ref.mounted && answersForTheCommunity(error)) {
          await Future.wait([
            reconcile(),
            reconcileCommunity(ref, _communityId),
          ]);
        }
        return WriteFailed(error);
      }
      if (ref.mounted) await reconcile();
      return WriteDone(answer);
    } finally {
      if (ref.mounted) _setWriting(null);
      alive.close();
    }
  }

  void _setWriting(GrantWrite? write) {
    _writing = write;
    final current = state.isLoading ? null : state.value;
    if (current == null) return; // build() carries it when it lands
    state = AsyncData(current.withWriting(write));
  }

  bool _stale(int sentAt) => _marked > sentAt;

  /// Every page of the member's grants: the server pages them, and a member
  /// holds at most one per capability. A page that brings nothing new ends
  /// the walk.
  Future<MemberGrantsState> _grants(CommunityRepository repository) async {
    try {
      final grants = <CommunityGrant>[];
      final seen = <String>{};
      String? cursor;
      do {
        final page = await repository.grants(
          _communityId,
          userId: member.userId,
          cursor: cursor,
        );
        final fresh = [
          for (final g in page.items)
            if (seen.add(g.grantId)) g,
        ];
        grants.addAll(fresh);
        cursor = fresh.isEmpty ? null : page.nextCursor;
      } while (cursor != null);
      return MemberGrantsState(grants: List.unmodifiable(grants));
    } on CommunityException catch (error) {
      if (error.isForbidden) return const MemberGrantsState(forbidden: true);
      if (error.isGone) return const MemberGrantsState(gone: true);
      rethrow;
    }
  }

  void _onEvent(RealtimeEvent event) {
    if (event is! CommunityEvent || event.communityId != _communityId) return;
    switch (event) {
      case CommunityAccessChangedEvent():
        unawaited(_read());
      case CommunityMemberRemovedEvent(:final userId) ||
              CommunityMemberAddedEvent(:final userId)
          when concernsViewer(ref, userId):
        unawaited(_read());
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(_read());
  }

  /// The grants again, replacing what is shown. One at a time, re-run once
  /// if asked for meanwhile; a failure other than a refusal keeps what is
  /// shown, and an answer to a read sent before the server last answered a
  /// change is dropped and the grants read again.
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
      final MemberGrantsState next;
      try {
        next = await _grants(ref.read(communityRepositoryProvider));
      } on CommunityException {
        if (!ref.mounted) return;
        if (_stale(sentAt)) _readAgain = true;
        continue;
      }
      if (!ref.mounted) return;
      if (_stale(sentAt)) {
        _readAgain = true;
        continue;
      }
      state = AsyncData(next.withWriting(_writing));
    } while (_readAgain && ref.mounted);
  }
}

final memberGrantsProvider = AsyncNotifierProvider.autoDispose
    .family<MemberGrantsController, MemberGrantsState, MemberKey>(
      MemberGrantsController.new,
      retry: (_, _) => null,
    );
