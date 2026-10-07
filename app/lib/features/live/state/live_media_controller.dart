import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/media/live_media_seams.dart';
import '../../../data/models/live.dart';
import '../../../data/models/live_media.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';

/// Orchestrates ONE live session's media TRANSPORT — nothing of its authority.
///
/// It owns the connect/disconnect lifecycle: it asks the repository for a join
/// credential ([LiveRepository.join]), hands the grant to the [LiveMediaClient],
/// mirrors the client's [LiveMediaState], and relays the microphone and
/// screen-share commands. It decides only transport questions — whether a
/// connection may start, and whether a terminal media drop warrants a fresh
/// join — never who may do what.
///
/// It does NOT own the session (that is [LiveSessionController] →
/// [LiveSession]); it never copies or fabricates `LiveSession`,
/// `presenterUserIds`, `me.*`, `stateVersion` or moderation state, never talks
/// HTTP or realtime directly, and knows no media SDK. The two machines stay
/// separate: this one answers "is THIS device carrying the audio", the session
/// controller answers "is a session live".
///
/// Joining is EXPLICIT: nothing here connects on construction, on build, on a
/// session load or on a realtime event — only [connect] does, when commanded.
class LiveMediaController extends Notifier<LiveMediaState> {
  LiveMediaController(this.sessionId);

  final String sessionId;

  /// Bumped by every [connect] and every [disconnect]: an async step tagged
  /// with an old generation must not touch state (the stale-result guard).
  int _generation = 0;

  /// A connect operation is in flight — a second [connect] is ignored, never a
  /// duplicate `/join`.
  bool _connecting = false;

  /// Single-flight for the room-reset re-join liveness check.
  Future<void>? _rejoining;

  @override
  LiveMediaState build() {
    final client = ref.watch(liveMediaClientProvider);
    // Listen before anything else, so no state the client emits is missed; the
    // subscription is the only writer besides this controller's own commands.
    final events = client.states.listen(_onMediaState);
    ref.onDispose(() {
      // No reconnect, no callback and no leaked subscription after disposal.
      _generation++;
      _connecting = false;
      unawaited(events.cancel());
    });
    return client.state;
  }

  LiveRepository get _repository => ref.read(liveRepositoryProvider);
  LiveMediaClient get _client => ref.read(liveMediaClientProvider);

  /// Joins the session's media room — explicit, and the only path that calls
  /// `/join`. Ignored while a connection is live or on its way; a fresh one may
  /// begin from idle, disconnected or failed. A join refusal surfaces as the
  /// repository's [LiveException] (state kept idle); a media-connect failure
  /// shows as [LiveMediaFailed]. Never fabricates `connected` — the client's
  /// own stream reports that.
  Future<void> connect() async {
    final client = _client;
    if (!client.isAvailable) {
      state = const LiveMediaUnavailable();
      return;
    }
    final current = state;
    if (current is LiveMediaConnecting ||
        current is LiveMediaConnected ||
        current is LiveMediaReconnecting) {
      return;
    }
    if (_connecting) return;

    _connecting = true;
    final gen = ++_generation;
    state = const LiveMediaConnecting();
    try {
      final LiveMediaGrant grant;
      try {
        grant = await _repository.join(sessionId);
      } on LiveException {
        // A join refusal is HTTP authority, never a media disconnect reason.
        if (_isCurrent(gen)) state = const LiveMediaIdle();
        rethrow;
      }
      // Disconnected or disposed while the join was in flight: do not connect.
      if (!_isCurrent(gen)) return;
      try {
        await client.connect(grant);
      } on LiveMediaException {
        // A media-layer failure is shown through the media state, not an
        // HTTP exception; the client's stream may also report it.
        if (_isCurrent(gen)) state = const LiveMediaFailed();
        return;
      }
      // Connected is the client's to report, over its state stream.
    } finally {
      if (gen == _generation) _connecting = false;
    }
  }

  /// Leaves the media room by the viewer's choice. Invalidates any in-flight
  /// connect (so a late join cannot reconnect), returns to idle, and tells the
  /// client to disconnect. An explicit leave never triggers an auto-rejoin.
  Future<void> disconnect() async {
    _generation++;
    _connecting = false;
    if (ref.mounted) state = const LiveMediaIdle();
    await _client.disconnect();
  }

  /// Turns the microphone on or off — only while connected, and only ever what
  /// the grant permits (the client enforces that). Rejected with a
  /// [LiveMediaException] when not connected; never a pretended success. Reads
  /// no authority and changes no session state.
  Future<void> setMicrophoneEnabled(bool enabled) async {
    _requireConnected();
    await _client.setMicrophoneEnabled(enabled);
  }

  /// Starts or stops sharing the screen — only while connected. The presenter
  /// AUTHORITY (`presenterUserIds`, `me.presenting`) is the server's and is
  /// never touched here; this only toggles the media track.
  Future<void> setScreenShareEnabled(bool enabled) async {
    _requireConnected();
    await _client.setScreenShareEnabled(enabled);
  }

  // ── The media connection's own reports ───────────────────────────────────

  void _onMediaState(LiveMediaState next) {
    if (!ref.mounted) return;
    state = next;
    // A terminal drop that needs a FRESH credential: the old one named a room
    // that is now gone. Only this reason may lead to a re-join.
    if (next is LiveMediaDisconnected &&
        next.reason == LiveMediaDisconnectReason.roomDeleted) {
      unawaited(_rejoinIfLive());
    }
    // duplicateIdentity / participantRemoved: terminal, no auto-rejoin — the
    // viewer may connect() again explicitly. `other`: the client has already
    // run its own retries; the controller does not loop (a bounded backoff is
    // an open decision, below).
  }

  /// A room reset (roomDeleted) while the session is still live needs a fresh
  /// `/join` to the new room. The session's liveness is read once, through the
  /// repository — not a second session state machine, not realtime. A session
  /// that has ended (or is no longer the viewer's) leaves media disconnected.
  Future<void> _rejoinIfLive() {
    final running = _rejoining;
    if (running != null) return running;
    return _rejoining = _runRejoinIfLive().whenComplete(
      () => _rejoining = null,
    );
  }

  Future<void> _runRejoinIfLive() async {
    final gen = _generation;
    final LiveSession session;
    try {
      session = await _repository.getSession(sessionId);
    } on LiveException {
      return; // gone/unreadable/transient: stay disconnected.
    }
    // Disconnected or disposed while the liveness read was in flight.
    if (!_isCurrent(gen)) return;
    if (!session.isLive) return; // ended: stay disconnected.
    try {
      await connect();
    } on LiveException {
      // The fresh join was refused; stay as the connect attempt left it.
    }
  }

  void _requireConnected() {
    if (state is! LiveMediaConnected) {
      throw const LiveMediaException(
        'not_connected',
        'Not connected to the session audio.',
      );
    }
  }

  bool _isCurrent(int gen) => ref.mounted && gen == _generation;
}

final liveMediaProvider = NotifierProvider.autoDispose
    .family<LiveMediaController, LiveMediaState, String>(
      LiveMediaController.new,
      retry: (_, _) => null,
    );
