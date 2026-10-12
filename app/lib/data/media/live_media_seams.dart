/// The live-session media seam.
///
/// This build has no live audio. Joining a room, speaking and hearing are a
/// native-media concern (LiveKit, which pulls in `flutter_webrtc`), and a
/// native dependency is never added blind — it cannot be built or verified on
/// a device from here (see lib/data/media/media_seams.dart, and the guard in
/// test/live/live_boundaries_test.dart).
///
/// So media participation lives behind this interface, with an "Unavailable"
/// default: the live-session screen is built and tested against the seam and
/// states plainly that audio is not available yet. When live audio lands it
/// lands here — behind this same seam, bound in one provider, as its own
/// reviewed change — and no screen that composes the seam has to change. The
/// media vocabulary it works in ([LiveMediaGrant], [LiveMediaState],
/// [LiveMediaDisconnectReason]) is plain Dart in data/models/live_media.dart;
/// no provider type ever crosses this boundary.
library;

import 'dart:async';

import '../models/live_media.dart';

/// This build's part in a live session's media. It consumes a
/// [LiveMediaGrant] — the only layer that ever touches the credential — and
/// exposes where the connection stands; it decides no authorization (that is
/// the server's) and reconnect policy is a later slice. A real implementation
/// is bound in one provider, never constructed by a screen.
abstract interface class LiveMediaClient {
  /// False until a real media client is bound — a later, reviewed change.
  bool get isAvailable;

  /// Where the connection stands now.
  LiveMediaState get state;

  /// Every change of [state].
  Stream<LiveMediaState> get states;

  /// The live, SDK-reconciled publication state: the server's current
  /// screen-publish authorization and the actually published microphone/screen
  /// tracks. Distinct from [state] (the connection) and from any in-flight
  /// command. Always safe to read.
  LiveMediaPublication get publication;

  /// Every change of [publication].
  Stream<LiveMediaPublication> get publications;

  /// The remote participants the SDK currently sees in the active room — their
  /// presence and reconciled audio/screen state, keyed by identity (the backend
  /// user id). Transport state only, kept DISTINCT from the local [publication]
  /// and never a second source of identity, moderation or attendance. Always
  /// safe to read.
  LiveRemoteParticipants get remoteParticipants;

  /// Every change of [remoteParticipants].
  Stream<LiveRemoteParticipants> get remoteParticipantChanges;

  /// Joins the session's media room with the server's credential. The grant is
  /// consumed here and not kept; nothing above this seam holds the token.
  Future<void> connect(LiveMediaGrant grant);

  /// Turns the local microphone on or off (only ever what the grant permits).
  Future<void> setMicrophoneEnabled(bool enabled);

  /// Starts or stops sharing the screen (only ever what the grant permits).
  Future<void> setScreenShareEnabled(bool enabled);

  /// Leaves the media room. Always safe to call, connected or not.
  Future<void> disconnect();
}

/// The default: no media. There is nothing to join and nothing to hear, and
/// the UI says so rather than pretending otherwise. Reads answer `unavailable`;
/// a connect or a publish fails explicitly ([LiveMediaException]) — never a
/// pretended success — and disconnect is a safe no-op.
class UnavailableLiveMediaClient implements LiveMediaClient {
  const UnavailableLiveMediaClient();

  static const LiveMediaException _unavailable = LiveMediaException(
    'media_unavailable',
    'Live audio is not available in this build.',
  );

  @override
  bool get isAvailable => false;

  @override
  LiveMediaState get state => const LiveMediaUnavailable();

  @override
  Stream<LiveMediaState> get states =>
      Stream<LiveMediaState>.value(const LiveMediaUnavailable());

  @override
  LiveMediaPublication get publication => const LiveMediaPublication();

  @override
  Stream<LiveMediaPublication> get publications =>
      Stream<LiveMediaPublication>.value(const LiveMediaPublication());

  @override
  LiveRemoteParticipants get remoteParticipants => LiveRemoteParticipants.empty;

  @override
  Stream<LiveRemoteParticipants> get remoteParticipantChanges =>
      Stream<LiveRemoteParticipants>.value(LiveRemoteParticipants.empty);

  @override
  Future<void> connect(LiveMediaGrant grant) async => throw _unavailable;

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async => throw _unavailable;

  @override
  Future<void> setScreenShareEnabled(bool enabled) async => throw _unavailable;

  @override
  Future<void> disconnect() async {}
}
