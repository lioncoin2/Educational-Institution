import 'dart:async';

import 'package:flutter/widgets.dart' show AppLifecycleListener;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show KeepAliveLink;

import '../../../data/media/live_media_seams.dart';
import '../../../data/models/auth.dart';
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

  /// Holds this controller (and so the connection) alive while the media is
  /// live, even when no live screen is watching — see [_syncLiveness].
  KeepAliveLink? _keepAlive;

  /// The session's community, given by [connect] — what the app-wide live bar
  /// needs to route the viewer back to the room.
  String? _communityId;

  @override
  LiveMediaState build() {
    final client = ref.watch(liveMediaClientProvider);
    final registry = ref.read(liveActiveSessionProvider.notifier);
    // A rebuild drops the previous build's keep-alive links.
    _keepAlive = null;
    // Listen before anything else, so no state the client emits is missed; the
    // subscription is the only writer besides this controller's own commands.
    final events = client.states.listen(_onMediaState);
    ref.onDispose(() {
      // No reconnect, no callback and no leaked subscription after disposal.
      _generation++;
      _connecting = false;
      unawaited(events.cancel());
      // (The live-room registry needs no clearing here: disposal only follows a
      // non-live state, which [_syncLiveness] has already cleared, and a
      // provider may not modify another while disposing.)
      // Disposal LEAVES the room. It happens once nothing keeps the controller:
      // the connection is no longer live (an explicit leave, a terminal drop,
      // the session ending) and no screen watches it — or the media client
      // itself is replaced. Best-effort: the client swallows a teardown error,
      // lands idle, and the port's teardown is already null-safe.
      unawaited(client.disconnect());
    });
    // Navigating away is NOT leaving: while the connection is live this
    // controller keeps itself alive, so the viewer can move around the app and
    // come back to the same room, still connected; the app-wide live bar shows
    // the connection everywhere meanwhile, so it is never hidden. Leaving stays
    // explicit ([disconnect]).
    listenSelf((_, next) => _syncLiveness(next, registry));
    // A connection that outlives its screen must not outlive the account:
    // signing out (or another account signing in) leaves the room.
    if (ref.exists(sessionUserProvider)) {
      ref.listen<AsyncValue<CurrentUser?>>(sessionUserProvider, (
        previous,
        next,
      ) {
        final signedInAs = previous?.value?.id;
        if (signedInAs == null || next.isLoading) return;
        if (next.value?.id != signedInAs && _isLive(state)) {
          unawaited(disconnect());
        }
      });
    }
    // Native only: leaving the foreground turns a live mic off (see
    // liveMediaMuteInBackgroundProvider). Released with the controller.
    if (ref.watch(liveMediaMuteInBackgroundProvider)) {
      final lifecycle = AppLifecycleListener(
        onHide: () => unawaited(_muteForBackground()),
      );
      ref.onDispose(lifecycle.dispose);
    }
    return client.state;
  }

  LiveRepository get _repository => ref.read(liveRepositoryProvider);
  LiveMediaClient get _client => ref.read(liveMediaClientProvider);

  /// Joins the session's media room — explicit, and the only path that calls
  /// `/join`. Ignored while a connection is live or on its way; a fresh one may
  /// begin from idle, disconnected or failed. A join refusal surfaces as the
  /// repository's [LiveException] (state kept idle); a media-connect failure
  /// shows as [LiveMediaFailed]. Never fabricates `connected` — the client's
  /// own stream reports that. [communityId] names the room for the app-wide
  /// live bar; a re-join keeps the one already given.
  Future<void> connect({String? communityId}) async {
    if (communityId != null) _communityId = communityId;
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

  /// Live (connecting, connected, or reconnecting across a blip): keep the
  /// controller alive and tell the app which room this device is in. Anything
  /// else (idle, a terminal drop, a failure): release both, so an ended
  /// connection never lingers — the controller then disposes once no screen
  /// watches it.
  void _syncLiveness(
    LiveMediaState next,
    LiveActiveSessionNotifier registry,
  ) {
    if (_isLive(next)) {
      _keepAlive ??= ref.keepAlive();
      final communityId = _communityId;
      if (communityId != null) {
        registry.enter(
          LiveActiveSession(communityId: communityId, sessionId: sessionId),
        );
      }
    } else {
      _keepAlive?.close();
      _keepAlive = null;
      registry.leave(sessionId);
    }
  }

  static bool _isLive(LiveMediaState state) =>
      state is LiveMediaConnecting ||
      state is LiveMediaConnected ||
      state is LiveMediaReconnecting;

  /// The app left the foreground on a native platform: turn a live microphone
  /// off rather than leave it "on" while the OS stops capturing it. The viewer
  /// turns it back on explicitly. Best-effort: a failure changes nothing the
  /// viewer can act on, and the SDK's reconciled publication drives the UI.
  Future<void> _muteForBackground() async {
    if (!ref.mounted || state is! LiveMediaConnected) return;
    final client = _client;
    if (!client.publication.microphoneOn) return;
    try {
      await client.setMicrophoneEnabled(false);
    } on Object {
      // Nothing to surface.
    }
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
    // The drop released the live keep-alive; hold the controller for the
    // liveness check, so a viewer elsewhere in the app is still re-joined.
    final hold = ref.keepAlive();
    return _rejoining = _runRejoinIfLive().whenComplete(() {
      _rejoining = null;
      hold.close();
    });
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

/// The live room THIS device is carrying audio for, if any — set while a media
/// connection is live, cleared when it ends. The app-wide [LiveActiveBar]
/// shows it on every other screen.
class LiveActiveSession {
  const LiveActiveSession({required this.communityId, required this.sessionId});

  final String communityId;
  final String sessionId;

  @override
  bool operator ==(Object other) =>
      other is LiveActiveSession &&
      other.communityId == communityId &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(communityId, sessionId);
}

class LiveActiveSessionNotifier extends Notifier<LiveActiveSession?> {
  @override
  LiveActiveSession? build() => null;

  void enter(LiveActiveSession session) {
    if (state != session) state = session;
  }

  /// Clears [sessionId] only — never another session that has since started.
  void leave(String sessionId) {
    if (state?.sessionId == sessionId) state = null;
  }
}

final liveActiveSessionProvider =
    NotifierProvider<LiveActiveSessionNotifier, LiveActiveSession?>(
      LiveActiveSessionNotifier.new,
    );

final liveMediaProvider = NotifierProvider.autoDispose
    .family<LiveMediaController, LiveMediaState, String>(
      LiveMediaController.new,
      retry: (_, _) => null,
    );

/// The live, SDK-reconciled media publication — the server's current
/// screen-publish authorization and the actually published microphone/screen
/// tracks — for the one media client. The UI watches this to reflect the REAL
/// track state and to gate the screen-share START on confirmed authorization,
/// kept DISTINCT from the connection state [liveMediaProvider] carries. Seeded
/// with the current snapshot so a late subscriber is never blank; autoDispose,
/// so the subscription lives only while a live screen is watching it.
final liveMediaPublicationProvider =
    StreamProvider.autoDispose<LiveMediaPublication>((ref) async* {
      final client = ref.watch(liveMediaClientProvider);
      yield client.publication;
      yield* client.publications;
    });

/// The REMOTE participants the media client currently sees in the active room —
/// presence + reconciled audio/screen state, keyed by identity (the backend
/// user id). The roster watches this to show a live media indicator per hand,
/// matched by `userId`. Transport state only: it never overrides the server's
/// identity, moderation or attendance. Seeded with the current snapshot;
/// autoDispose, so the subscription lives only while a live screen watches it.
final liveRemoteParticipantsProvider =
    StreamProvider.autoDispose<LiveRemoteParticipants>((ref) async* {
      final client = ref.watch(liveMediaClientProvider);
      yield client.remoteParticipants;
      yield* client.remoteParticipantChanges;
    });

/// The live active-speaker audio LEVELS the media client sees (0..1 per
/// identity). The stage's on-air indicator watches this to react to the host's
/// voice. Amplitude only — never "speaking" authority or a source of identity.
/// Seeded with the current snapshot; autoDispose, so the subscription lives only
/// while a live screen watches it.
final liveAudioLevelsProvider = StreamProvider.autoDispose<LiveAudioLevels>((
  ref,
) async* {
  final client = ref.watch(liveMediaClientProvider);
  yield client.audioLevels;
  yield* client.audioLevelChanges;
});
