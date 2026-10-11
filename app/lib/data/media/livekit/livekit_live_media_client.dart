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

  /// The live, SDK-reconciled publication snapshot (authorization + the actual
  /// mic/screen tracks). `_screenAllowed` is its authoritative mirror for the
  /// publish gate; the two always move together.
  LiveMediaPublication _publication = const LiveMediaPublication();
  final StreamController<LiveMediaPublication> _publications =
      StreamController<LiveMediaPublication>.broadcast();

  @override
  bool get isAvailable => true;

  @override
  LiveMediaState get state => _state;

  @override
  Stream<LiveMediaState> get states => _states.stream;

  @override
  LiveMediaPublication get publication => _publication;

  @override
  Stream<LiveMediaPublication> get publications => _publications.stream;

  /// The latest server-authorized screen-share capability — the SDK's live
  /// participant permission, updated as the backend grants or revokes a
  /// presenter slot (never merely the join ticket). Distinct from whether a
  /// screen track is actually publishing; not part of the [LiveMediaClient]
  /// seam, this is exposed on the real adapter so the E2E can observe a live
  /// grant/revoke transition without triggering a capture.
  bool get screenAuthorized => _screenAllowed;

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
    // A fresh connection starts from a clean publication: the join
    // authorization, no tracks published yet. The SDK's live signals (capability
    // and local-track events) update it from here.
    _setPublication(LiveMediaPublication(screenAuthorized: grant.screen));
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
    // A leave is best-effort and ALWAYS safe (the seam contract): the room is
    // being discarded, so a teardown error from the port is not something the
    // viewer can act on — it must neither surface nor strand the media state.
    try {
      await _port.disconnect();
    } on Object {
      // Swallow: the viewer has left; a failed teardown changes nothing, and a
      // leave that threw would reach the UI as an error. The token never
      // appears here (the port holds it), so nothing sensitive is dropped.
    } finally {
      // The viewer's own leave returns to idle; the controller also owns this.
      // Drop the cached authorization too, so a stale grant can never outlive
      // the connection it belonged to.
      _screenAllowed = false;
      _setPublication(const LiveMediaPublication());
      _set(const LiveMediaIdle());
    }
  }

  /// Releases the subscription, the port and the state stream. Not part of the
  /// [LiveMediaClient] contract — the owner (a provider's onDispose, or a test)
  /// calls it; no SDK listener or room outlives it.
  Future<void> dispose() async {
    await _signals.cancel();
    await _port.dispose();
    if (!_states.isClosed) await _states.close();
    if (!_publications.isClosed) await _publications.close();
  }

  void _onSignal(LiveKitRoomSignal signal) {
    switch (signal) {
      case LiveKitConnected():
        _set(const LiveMediaConnected());
      case LiveKitReconnecting():
        _set(const LiveMediaReconnecting());
      case LiveKitDisconnected(:final reason):
        _set(LiveMediaDisconnected(reason));
      case LiveKitCapabilities(:final canPublishScreen):
        // The server's live authorization — the only thing that un-blocks (or
        // re-blocks) screen sharing mid-session. A grant NEVER starts capture
        // (that needs explicit user intent); a revoke DOES stop any active
        // capture, driven by this server signal rather than the UI. Idempotent:
        // a repeated or no-change update only re-sets the flag, and only a
        // genuine allowed→denied transition stops capture, once.
        final wasAllowed = _screenAllowed;
        _screenAllowed = canPublishScreen;
        _setPublication(
          _publication.copyWith(screenAuthorized: canPublishScreen),
        );
        if (wasAllowed && !canPublishScreen) {
          unawaited(_stopScreenShareQuietly());
        }
      case LiveKitLocalTracks(:final microphoneOn, :final screenShareOn):
        // The SDK's reconciled view of OUR OWN published tracks — the single
        // source of the mic/screen "on" state the UI shows, never a command's
        // optimistic result.
        _setPublication(
          _publication.copyWith(
            microphoneOn: microphoneOn,
            screenShareOn: screenShareOn,
          ),
        );
    }
  }

  /// Stops any screen capture best-effort when screen authority is lost. A
  /// teardown error is swallowed (the track may already be gone server-side,
  /// and losing authority is not a user-actionable error); the token never
  /// appears here (the port holds it).
  Future<void> _stopScreenShareQuietly() async {
    try {
      await _port.setScreenShareEnabled(false, captureScreenAudio: false);
    } on Object {
      // Nothing to surface.
    }
  }

  void _set(LiveMediaState state) {
    _state = state;
    if (!_states.isClosed) _states.add(state);
  }

  /// Publishes a publication change only when something actually changed, so a
  /// no-change SDK event (e.g. a duplicate permission update) does not churn the
  /// stream.
  void _setPublication(LiveMediaPublication next) {
    if (next == _publication) return;
    _publication = next;
    if (!_publications.isClosed) _publications.add(next);
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
