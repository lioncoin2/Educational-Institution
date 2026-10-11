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

/// One connected LiveKit room reduced to the operations the port performs on
/// it: the publish commands and the three teardown steps it owns (dispose the
/// listener, leave the room, release the room object). SDK-free, so the port's
/// lifecycle — connect, mic/screen, teardown and reconnect — is unit-testable
/// against a fake; [_SdkLiveRoom] is the one SDK-backed implementation, and the
/// only unit that holds a LiveKit type.
abstract interface class LiveKitLiveRoom {
  Future<void> setMicrophoneEnabled(bool enabled);

  Future<void> setScreenShareEnabled(bool enabled, {bool captureScreenAudio});

  /// Dispose the room's event listener.
  Future<void> disposeListener();

  /// Leave the room (release the transport).
  Future<void> disconnect();

  /// Release the room object.
  Future<void> dispose();
}

/// Opens a connected [LiveKitLiveRoom] at [url] with [token], forwarding the
/// room's transport events to [emit]. Injected into [SdkLiveKitRoomPort] so
/// teardown and reconnection are testable without a real room or server; the
/// production default is [_openSdkRoom].
typedef LiveKitRoomOpener = Future<LiveKitLiveRoom> Function(
  String url,
  String token,
  void Function(LiveKitRoomSignal signal) emit,
);

/// The real port: owns exactly one [LiveKitLiveRoom] at a time, created fresh
/// per [connect] (through the injectable [LiveKitRoomOpener]) and torn down on
/// [disconnect]/[dispose]. A `clientInitiated` disconnect (our own leave) emits
/// no terminal signal — the adapter already owns that transition.
class SdkLiveKitRoomPort implements LiveKitRoomPort {
  SdkLiveKitRoomPort({LiveKitRoomOpener? openRoom})
    : _openRoom = openRoom ?? _openSdkRoom;

  final LiveKitRoomOpener _openRoom;

  final StreamController<LiveKitRoomSignal> _signals =
      StreamController<LiveKitRoomSignal>.broadcast();

  /// The one open room, or null between a teardown and the next [connect].
  /// Cleared FIRST by [_teardownRoom], so a failing teardown step can never
  /// leave a stale room that a later [connect] might reuse.
  LiveKitLiveRoom? _room;

  @override
  Stream<LiveKitRoomSignal> get signals => _signals.stream;

  @override
  Future<void> connect(String url, String token) async {
    // One room at a time. The previous room is being discarded, so tearing it
    // down here is best-effort: a stale room's cleanup failure is NOT a failure
    // of the new join (`connect` throws only on a join failure) and must never
    // block a reconnect — e.g. the roomDeleted auto-rejoin, where disconnecting
    // the already-deleted room can itself throw. `_teardownRoom()` still clears
    // `_room` synchronously, so nothing is orphaned; an explicit disconnect()
    // or dispose() still surfaces teardown errors — only this replace swallows.
    await _teardownRoom().catchError((_) {});
    _room = await _openRoom(url, token, _emit);
  }

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    await _room?.setMicrophoneEnabled(enabled);
  }

  @override
  Future<void> setScreenShareEnabled(
    bool enabled, {
    bool captureScreenAudio = false,
  }) async {
    await _room?.setScreenShareEnabled(
      enabled,
      captureScreenAudio: captureScreenAudio,
    );
  }

  @override
  Future<void> disconnect() => _teardownRoom();

  @override
  Future<void> dispose() async {
    // Teardown is best-effort, but the signal controller MUST be closed even
    // when teardown throws — otherwise the broadcast controller itself leaks.
    // A teardown error still propagates after the close: dispose()'s own
    // error contract is unchanged (it could throw before too); only the
    // unclosed-controller leak is fixed.
    try {
      await _teardownRoom();
    } finally {
      if (!_signals.isClosed) await _signals.close();
    }
  }

  /// Clears [_room] FIRST, then releases its resources best-effort. Nulling
  /// first is the invariant that keeps reconnection safe: whatever happens in
  /// teardown, the next [connect] starts from a clean slate and the old room is
  /// never re-touched.
  Future<void> _teardownRoom() {
    final room = _room;
    _room = null;
    if (room == null) return Future<void>.value();
    return _teardownResources(
      disposeListener: room.disposeListener,
      disconnect: room.disconnect,
      disposeRoom: room.dispose,
    );
  }

  void _emit(LiveKitRoomSignal signal) {
    if (!_signals.isClosed) _signals.add(signal);
  }
}

/// Releases a room's owned resources best-effort: listener disposal, THEN room
/// disconnection, THEN room disposal — each attempted even if an earlier one
/// throws, so a single failing step can never strand an open transport or a
/// live object. (A deliberate per-resource guard, not one broad catch around
/// the sequence.) The FIRST error, if any, is rethrown with its stack once
/// every attempt has run, so a caller's error contract is unchanged — only the
/// leak is closed. Nothing here reads or formats the error, so no message, URL
/// or token is ever logged or exposed.
Future<void> _teardownResources({
  required Future<void> Function() disposeListener,
  required Future<void> Function() disconnect,
  required Future<void> Function() disposeRoom,
}) async {
  Object? firstError;
  StackTrace? firstStack;
  Future<void> attempt(Future<void> Function() op) async {
    try {
      await op();
    } catch (error, stack) {
      // Keep only the first failure; every resource still gets its attempt.
      firstError ??= error;
      firstStack ??= stack;
    }
  }

  await attempt(disposeListener);
  await attempt(disconnect);
  await attempt(disposeRoom);

  final error = firstError;
  if (error != null) Error.throwWithStackTrace(error, firstStack!);
}

/// The production [LiveKitRoomOpener]: builds a LiveKit [Room], registers its
/// event handlers BEFORE connecting (so the connected event is never missed),
/// then connects. If the connect fails, the half-open room is released
/// best-effort before the failure surfaces, so a failed join leaks nothing; the
/// connect error — never a secondary teardown error — is what propagates.
Future<LiveKitLiveRoom> _openSdkRoom(
  String url,
  String token,
  void Function(LiveKitRoomSignal signal) emit,
) async {
  final room = Room();
  final listener = room.createListener();
  listener
    ..on<RoomConnectedEvent>((_) => emit(const LiveKitConnected()))
    ..on<RoomReconnectingEvent>((_) => emit(const LiveKitReconnecting()))
    ..on<RoomReconnectedEvent>((_) => emit(const LiveKitConnected()))
    ..on<RoomDisconnectedEvent>((event) {
      // Our own leave is not a remote failure.
      if (event.reason == DisconnectReason.clientInitiated) return;
      emit(LiveKitDisconnected(liveKitDisconnectReason(event.reason)));
    });
  try {
    await room.connect(url, token);
  } catch (_) {
    await _teardownResources(
      disposeListener: () async => listener.dispose(),
      disconnect: () async => room.disconnect(),
      disposeRoom: () async => room.dispose(),
    ).catchError((_) {});
    rethrow;
  }
  return _SdkLiveRoom(room, listener);
}

/// The SDK-backed [LiveKitLiveRoom]: owns exactly one LiveKit [Room] and its
/// [EventsListener], and translates the port's operations into SDK calls.
class _SdkLiveRoom implements LiveKitLiveRoom {
  _SdkLiveRoom(this._room, this._listener);

  final Room _room;
  final EventsListener<RoomEvent> _listener;

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    await _room.localParticipant?.setMicrophoneEnabled(enabled);
  }

  @override
  Future<void> setScreenShareEnabled(
    bool enabled, {
    bool captureScreenAudio = false,
  }) async {
    await _room.localParticipant?.setScreenShareEnabled(
      enabled,
      captureScreenAudio: captureScreenAudio,
    );
  }

  @override
  Future<void> disposeListener() async {
    await _listener.dispose();
  }

  @override
  Future<void> disconnect() async {
    await _room.disconnect();
  }

  @override
  Future<void> dispose() async {
    await _room.dispose();
  }
}
