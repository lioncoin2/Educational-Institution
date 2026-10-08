import 'dart:async';

import '../../models/live_media.dart';
import '../live_media_seams.dart';
import 'livekit_room_port.dart';

/// The real [LiveMediaClient], backed by LiveKit through [LiveKitRoomPort].
///
/// It translates between the app's media contract and a LiveKit room: a
/// [LiveMediaGrant] becomes `Room.connect(url, token)`, the room's signals
/// become [LiveMediaState], and the publish commands delegate to the room. It
/// does NOT own session authority, admission, token refresh, reconnect policy
/// or `/join` — those are the controller's and the backend's. It holds no
/// LiveKit type (the port does) and never keeps, logs or echoes the token.
///
/// This class is unit-tested against a fake port; the one SDK-touching unit is
/// [SdkLiveKitRoomPort]. It is not yet bound to `liveMediaClientProvider` — the
/// build still uses `UnavailableLiveMediaClient` until platform activation.
class LiveKitLiveMediaClient implements LiveMediaClient {
  LiveKitLiveMediaClient({LiveKitRoomPort? port})
    : _port = port ?? SdkLiveKitRoomPort() {
    _signals = _port.signals.listen(_onSignal);
  }

  final LiveKitRoomPort _port;
  late final StreamSubscription<LiveKitRoomSignal> _signals;
  final StreamController<LiveMediaState> _states =
      StreamController<LiveMediaState>.broadcast();

  LiveMediaState _state = const LiveMediaIdle();

  /// The current grant's screen-share capability — the app-level ceiling for
  /// [setScreenShareEnabled]. Only the capability flag is kept; never the token.
  bool _screenAllowed = false;

  @override
  bool get isAvailable => true;

  @override
  LiveMediaState get state => _state;

  @override
  Stream<LiveMediaState> get states => _states.stream;

  @override
  Future<void> connect(LiveMediaGrant grant) async {
    // Reject an obviously unusable grant before touching the SDK.
    if (grant.token.isEmpty || grant.url.isEmpty) {
      throw const LiveMediaException(
        'invalid_grant',
        'The media grant is missing a connection URL or token.',
      );
    }
    _screenAllowed = grant.screen;
    _set(const LiveMediaConnecting());
    try {
      await _port.connect(grant.url, grant.token);
    } catch (error) {
      _set(const LiveMediaFailed());
      throw _mediaError(error);
    }
    // `connected` is the room's to report, over the signal stream.
  }

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    _requireConnected();
    try {
      await _port.setMicrophoneEnabled(enabled);
    } catch (error) {
      throw _mediaError(error);
    }
  }

  @override
  Future<void> setScreenShareEnabled(bool enabled) async {
    _requireConnected();
    if (enabled && !_screenAllowed) {
      throw const LiveMediaException(
        'screen_not_permitted',
        'Screen sharing is not permitted in this session.',
      );
    }
    try {
      // Screen audio is never forced on (the grant keeps it off, Q56).
      await _port.setScreenShareEnabled(enabled, captureScreenAudio: false);
    } catch (error) {
      throw _mediaError(error);
    }
  }

  @override
  Future<void> disconnect() async {
    await _port.disconnect();
    // The viewer's own leave returns to idle; the controller also owns this.
    _set(const LiveMediaIdle());
  }

  /// Releases the subscription, the port and the state stream. Not part of the
  /// [LiveMediaClient] contract — the owner (a provider's onDispose, or a test)
  /// calls it; no SDK listener or room outlives it.
  Future<void> dispose() async {
    await _signals.cancel();
    await _port.dispose();
    if (!_states.isClosed) await _states.close();
  }

  void _onSignal(LiveKitRoomSignal signal) {
    switch (signal) {
      case LiveKitConnected():
        _set(const LiveMediaConnected());
      case LiveKitReconnecting():
        _set(const LiveMediaReconnecting());
      case LiveKitDisconnected(:final reason):
        _set(LiveMediaDisconnected(reason));
    }
  }

  void _set(LiveMediaState state) {
    _state = state;
    if (!_states.isClosed) _states.add(state);
  }

  void _requireConnected() {
    if (_state is! LiveMediaConnected) {
      throw const LiveMediaException(
        'not_connected',
        'Not connected to the session audio.',
      );
    }
  }

  /// A sanitized media failure: a stable code and a generic message carrying
  /// only the error's TYPE for diagnostics — never its text, which could hold a
  /// URL or token. The credential never reaches an exception.
  LiveMediaException _mediaError(Object error) => LiveMediaException(
    'media_error',
    'The live media operation failed (${error.runtimeType}).',
  );
}
