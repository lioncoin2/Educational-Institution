import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/live.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';

/// Follows a community's live session, read-only.
///
/// The state is the running session, or null when none is live now; loading
/// and error are the [AsyncValue] around it. The HTTP read is the authority:
/// [LiveRepository.currentSession] discovers which session is running, and
/// [LiveRepository.getSession] re-reads one by id. Realtime [LiveEvent]s are
/// only HINTS — this controller never builds a [LiveSession] from an event; it
/// reconciles by reading the server again.
///
/// It is session-aware: an event for another community, or for a session this
/// controller does not hold, is ignored, so one community's stream can never
/// reconcile another's state. A `changed` hint fetches only when its
/// [stateVersion] is newer than what is held — the version guards against a
/// stale or redundant re-read. A reconnect re-reads the session outright, since
/// anything may have been missed while the connection was gone.
///
/// Media is a separate seam (lib/data/media/live_media_seams.dart), unbound in
/// this build: the media-room events (`participant.removed`, `media_reset`)
/// change no session state here. What the viewer may do is the server's `me`,
/// never worked out here.
class LiveSessionController extends AsyncNotifier<LiveSession?> {
  LiveSessionController(this.communityId);

  final String communityId;

  /// A session hint arrived before the first load finished: catch up once the
  /// session is on screen, so the load/subscribe gap drops nothing.
  bool _sessionChangedWhileLoading = false;

  /// Single-flight re-reads (the messaging controller's proven shape): asked
  /// for again while one runs, it runs once more after — never two at once,
  /// and a newer read never loses to an older one landing late.
  Future<void>? _reconciling;
  bool _reconcileAgain = false;
  Future<void>? _rediscovering;
  bool _rediscoverAgain = false;

  @override
  Future<LiveSession?> build() async {
    // A different signed-in viewer is a different answer: read again when the
    // account changes, not merely when the session resolves to the same one.
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    final repository = ref.watch(liveRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);

    // Listen before the first read so nothing that arrives during it is lost:
    // such hints set a flag and are caught up once the session is loaded.
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });
    listenSelf((previous, next) {
      final firstLoad =
          (previous == null || !previous.hasValue) && next.hasValue;
      if (firstLoad && _sessionChangedWhileLoading) {
        _sessionChangedWhileLoading = false;
        unawaited(_rediscover());
      }
    });

    return repository.currentSession(communityId);
  }

  LiveRepository get _repository => ref.read(liveRepositoryProvider);

  /// Reads the current session again. A failure surfaces to the screen's retry.
  Future<void> refresh() {
    ref.invalidateSelf();
    return future.then<void>((_) {}, onError: (Object _) {});
  }

  // ── The live connection ─────────────────────────────────────────────────

  void _onEvent(RealtimeEvent event) {
    // Our community's live events only: a hint for another community, or a
    // non-live event, is never this session's business.
    if (event is! LiveEvent || event.communityId != communityId) return;

    // Still loading: the initial read plus the post-load catch-up cover it.
    if (!state.hasValue) {
      if (event is LiveSessionStartedEvent ||
          event is LiveSessionChangedEvent ||
          event is LiveSessionEndedEvent) {
        _sessionChangedWhileLoading = true;
      }
      return;
    }

    final current = state.value;
    switch (event) {
      case LiveSessionStartedEvent():
        // A session exists in our community now. Discover it over HTTP unless
        // we already hold exactly it, live. Never built from the hint.
        if (!(current != null &&
            current.isLive &&
            current.id == event.sessionId)) {
          unawaited(_rediscover());
        }
      case LiveSessionChangedEvent():
        // Ours, and newer than what is held: the version gate re-reads only
        // then. A session we do not hold, or an equal/older version, is old
        // news — no HTTP.
        if (current != null &&
            event.sessionId == current.id &&
            event.stateVersion > current.stateVersion) {
          unawaited(_reconcile(current.id));
        }
      case LiveSessionEndedEvent():
        // Terminal for this session: re-read the authoritative (ended) view;
        // the backend keeps endedAt/endReason, nothing is fabricated here. An
        // ended for a session we do not hold is not ours to apply.
        if (current != null && event.sessionId == current.id) {
          unawaited(_reconcile(current.id));
        }
      case LiveParticipantRemovedEvent():
      case LiveSessionMediaResetEvent():
        // Media-room facts. This non-media phase holds no media state to
        // change, and neither names a participant to act on. Session state is
        // left intact; a future media phase consumes the appropriate signal.
        break;
    }
  }

  /// Back online — connected the first time, or again after a drop. Whatever
  /// happened while the connection was gone was not delivered, so re-read the
  /// authoritative session rather than trust local state.
  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(_rediscover());
  }

  /// Re-reads one session by id and replaces state, newest-wins. The authority
  /// for a `changed` or an `ended` hint about a session we hold.
  Future<void> _reconcile(String sessionId) {
    final running = _reconciling;
    if (running != null) {
      _reconcileAgain = true;
      return running;
    }
    return _reconciling = _runReconcile(sessionId)
        .whenComplete(() => _reconciling = null);
  }

  Future<void> _runReconcile(String sessionId) async {
    do {
      _reconcileAgain = false;
      final LiveSession fresh;
      try {
        fresh = await _repository.getSession(sessionId);
      } on LiveException catch (error) {
        if (!ref.mounted) return;
        final current = state.value;
        // Gone or no longer the viewer's to see: the session is over.
        if (error.isGone && current != null && current.id == sessionId) {
          state = const AsyncData(null);
        }
        // Any other refusal is transient: keep what is shown; the next
        // reconnect re-reads authoritatively.
        return;
      }
      if (!ref.mounted) return;
      final current = state.value;
      // Apply only while we still hold this very session and the read is not
      // older than what is held — a doorway read that concluded "no session",
      // or a newer read that already landed, must not be undone.
      if (current != null &&
          current.id == sessionId &&
          fresh.stateVersion >= current.stateVersion) {
        state = AsyncData(fresh);
      }
    } while (_reconcileAgain && ref.mounted);
  }

  /// Re-reads which session is running in the community (the doorway), and
  /// shows it — or null when none is. Used to discover a started session and
  /// to re-synchronise on reconnect.
  Future<void> _rediscover() {
    final running = _rediscovering;
    if (running != null) {
      _rediscoverAgain = true;
      return running;
    }
    return _rediscovering = _runRediscover().whenComplete(
      () => _rediscovering = null,
    );
  }

  Future<void> _runRediscover() async {
    do {
      _rediscoverAgain = false;
      final LiveSession? session;
      try {
        session = await _repository.currentSession(communityId);
      } on LiveException {
        // Transient: keep what is shown; the next reconnect tries again.
        return;
      }
      if (!ref.mounted) return;
      state = AsyncData(session);
    } while (_rediscoverAgain && ref.mounted);
  }
}

final liveSessionProvider = AsyncNotifierProvider.autoDispose
    .family<LiveSessionController, LiveSession?, String>(
      LiveSessionController.new,
      retry: (_, _) => null,
    );
