import 'dart:async';

import 'package:livekit_client/livekit_client.dart';

import '../../models/live_media.dart';

/// The LiveKit boundary, isolated so the adapter's lifecycle and state
/// translation are testable without the SDK or a live server.
///
/// [LiveKitRoomPort] is SDK-agnostic: its signals carry only the app's own
/// vocabulary ([LiveKitRoomSignal] / [LiveMediaDisconnectReason]), never a
/// LiveKit type. The real [SdkLiveKitRoomPort] (below) is the single unit that
/// owns a LiveKit `Room`, subscribes to its events and translates them; a test
/// fake stands in for it to drive the adapter. Everything here lives inside the
/// `lib/data/media/livekit/` boundary — the only place `package:livekit_client`
/// is imported.
abstract interface class LiveKitRoomPort {
  /// Connects to [url] with the ephemeral [token]. Completes when the room is
  /// joined; throws on failure (the adapter maps that to a media failure). The
  /// token is handed straight to the SDK and never kept, logged or echoed.
  Future<void> connect(String url, String token);

  Future<void> setMicrophoneEnabled(bool enabled);

  /// Screen share. [captureScreenAudio] is always false in this build (Q56).
  Future<void> setScreenShareEnabled(bool enabled, {bool captureScreenAudio});

  /// Leaves the room; safe to call when already disconnected.
  Future<void> disconnect();

  /// The room's transport signals, in the app's vocabulary.
  Stream<LiveKitRoomSignal> get signals;

  /// Releases the room and its listeners.
  Future<void> dispose();
}

/// A transport signal from a LiveKit room, SDK-free. `failed` is NOT a signal —
/// a failed connect surfaces as [connect] throwing; these are the events of a
/// room that did connect.
sealed class LiveKitRoomSignal {
  const LiveKitRoomSignal();
}

/// Connected, or connected again after a reconnect.
final class LiveKitConnected extends LiveKitRoomSignal {
  const LiveKitConnected();
}

final class LiveKitReconnecting extends LiveKitRoomSignal {
  const LiveKitReconnecting();
}

/// The room dropped for good; [reason] is the app's own reason.
final class LiveKitDisconnected extends LiveKitRoomSignal {
  const LiveKitDisconnected(this.reason);

  final LiveMediaDisconnectReason reason;
}

/// Translates a LiveKit `DisconnectReason` into the app's own reason. Only the
/// three meaningful cases map across; everything else — `unknown`,
/// `serverShutdown`, `stateMismatch`, `joinFailure`, `disconnected`,
/// `clientInitiated` and null — is `other`. `clientInitiated` deliberately maps
/// to `other`, NEVER `participantRemoved`: a local leave is not a remote kick.
///
/// Note: `livekit_client` 2.13.0's `DisconnectReason` has no `roomClosed`
/// member (verified against the installed source), so only `roomDeleted` is
/// mapped; a future SDK adding `roomClosed` would fall through to `other` until
/// this map is widened.
LiveMediaDisconnectReason liveKitDisconnectReason(DisconnectReason? reason) =>
    switch (reason) {
      DisconnectReason.duplicateIdentity =>
        LiveMediaDisconnectReason.duplicateIdentity,
      DisconnectReason.roomDeleted => LiveMediaDisconnectReason.roomDeleted,
      DisconnectReason.participantRemoved =>
        LiveMediaDisconnectReason.participantRemoved,
      _ => LiveMediaDisconnectReason.other,
    };

/// The real port: owns exactly one LiveKit `Room` at a time, created fresh per
/// [connect] and torn down with its listener on [disconnect]/[dispose]. A
/// `clientInitiated` disconnect (our own leave) emits no terminal signal — the
/// adapter already owns that transition.
class SdkLiveKitRoomPort implements LiveKitRoomPort {
  final StreamController<LiveKitRoomSignal> _signals =
      StreamController<LiveKitRoomSignal>.broadcast();

  Room? _room;
  EventsListener<RoomEvent>? _listener;

  @override
  Stream<LiveKitRoomSignal> get signals => _signals.stream;

  @override
  Future<void> connect(String url, String token) async {
    // One room at a time: drop any previous before opening a new one.
    await _teardownRoom();
    final room = Room();
    _room = room;
    final listener = room.createListener();
    _listener = listener;
    // Register before connecting so the connected event is never missed.
    listener
      ..on<RoomConnectedEvent>((_) => _emit(const LiveKitConnected()))
      ..on<RoomReconnectingEvent>((_) => _emit(const LiveKitReconnecting()))
      ..on<RoomReconnectedEvent>((_) => _emit(const LiveKitConnected()))
      ..on<RoomDisconnectedEvent>((event) {
        // Our own leave is not a remote failure.
        if (event.reason == DisconnectReason.clientInitiated) return;
        _emit(LiveKitDisconnected(liveKitDisconnectReason(event.reason)));
      });
    await room.connect(url, token);
  }

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    await _room?.localParticipant?.setMicrophoneEnabled(enabled);
  }

  @override
  Future<void> setScreenShareEnabled(
    bool enabled, {
    bool captureScreenAudio = false,
  }) async {
    await _room?.localParticipant?.setScreenShareEnabled(
      enabled,
      captureScreenAudio: captureScreenAudio,
    );
  }

  @override
  Future<void> disconnect() => _teardownRoom();

  @override
  Future<void> dispose() async {
    await _teardownRoom();
    if (!_signals.isClosed) await _signals.close();
  }

  Future<void> _teardownRoom() async {
    final listener = _listener;
    final room = _room;
    _listener = null;
    _room = null;
    if (listener != null) await listener.dispose();
    if (room != null) {
      await room.disconnect();
      await room.dispose();
    }
  }

  void _emit(LiveKitRoomSignal signal) {
    if (!_signals.isClosed) _signals.add(signal);
  }
}
