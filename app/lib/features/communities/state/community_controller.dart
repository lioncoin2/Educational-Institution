import 'dart:async';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/communities.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../providers/app_providers.dart';
import 'community_viewer.dart';

class CommunityDetailState {
  const CommunityDetailState({this.community, this.removed = false});

  /// The server's last word on the community — kept after a removal, so the
  /// screen can still say which community it was. Null when the server never
  /// showed it (it answered "no such community" from the start).
  final Community? community;

  /// Not the viewer's any more — or never was. Nothing of it is offered.
  final bool removed;
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

  @override
  Future<CommunityDetailState> build() async {
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
    try {
      return CommunityDetailState(
        community: await repository.community(communityId),
      );
    } on CommunityException catch (error) {
      if (error.isGone) return const CommunityDetailState(removed: true);
      rethrow;
    }
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

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
            CommunityDetailState(community: current.community, removed: true),
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
    if (status.isLive) unawaited(_read());
  }

  /// GET /communities/:id again, quietly. One at a time; a read asked for
  /// meanwhile runs once more after it, so the last answer shown was asked
  /// for after the last frame — and one asked for while the build's read is
  /// on its way runs once that lands. A failure other than "not found"
  /// keeps what is shown.
  Future<void> _read() {
    if (state.isLoading) {
      _readAfterLoad = true;
      return Future.value();
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
      final Community fresh;
      try {
        fresh = await ref
            .read(communityRepositoryProvider)
            .community(communityId);
      } on CommunityException catch (error) {
        if (!ref.mounted) return;
        if (error.isGone) {
          state = AsyncData(
            CommunityDetailState(
              community: state.value?.community,
              removed: true,
            ),
          );
        }
        continue; // Asked for again meanwhile? Then once more.
      }
      if (!ref.mounted) return;
      state = AsyncData(CommunityDetailState(community: fresh));
    } while (_readAgain && ref.mounted);
  }
}

final communityProvider = AsyncNotifierProvider.autoDispose
    .family<CommunityController, CommunityDetailState, String>(
      CommunityController.new,
      retry: (_, _) => null,
    );
