/// The live-session MEDIA vocabulary, plain Dart — the data the media seam
/// works in, apart from the session's authority ([LiveSession], live.dart) and
/// from HTTP refusals ([LiveException]).
///
/// Three facts live here and nothing else: the join credential the server
/// issues ([LiveMediaGrant]), where a media connection stands
/// ([LiveMediaState]) and why one dropped ([LiveMediaDisconnectReason]). No
/// provider (LiveKit/WebRTC) type appears — the seam stays vendor-neutral, and
/// media participation itself is a later slice.
library;

import 'live.dart';

/// A short-lived media credential from `POST /live/sessions/:id/join`
/// (backend `JoinTicketResponse`). The server decides the identity, the room
/// and what the holder may publish and encodes them in [token]; the client
/// never states any of it.
///
/// It is EPHEMERAL: fetched when joining, handed straight to the media client,
/// then dropped. [token] is a credential — it is REDACTED from [toString] and
/// must never be logged, persisted, serialised, shown, or put in a navigation
/// argument. Only the media client consumes it.
class LiveMediaGrant {
  const LiveMediaGrant({
    required this.sessionId,
    required this.token,
    required this.url,
    required this.expiresInSeconds,
    required this.expiresAt,
    required this.role,
    required this.microphone,
    required this.screen,
    required this.screenAudio,
  });

  /// Throws [FormatException] when a required field — the session, the
  /// credential, the connection URL, or the expiry — is missing or unreadable.
  /// Everything else is read defensively (the live-model convention): an
  /// unknown role becomes `unknown`, a missing capability flag is false, and a
  /// missing lifetime is 0.
  factory LiveMediaGrant.fromJson(Map<String, Object?> json) {
    final rawMedia = json['media'];
    final media = rawMedia is Map
        ? rawMedia.cast<String, Object?>()
        : const <String, Object?>{};
    return LiveMediaGrant(
      sessionId: _required(json, 'sessionId'),
      token: _required(json, 'token'),
      url: _required(json, 'url'),
      expiresInSeconds: _int(json['expiresInSeconds']),
      expiresAt: _instant(json, 'expiresAt'),
      role: LiveParticipantRole.fromWire(json['role']),
      microphone: media['microphone'] == true,
      screen: media['screen'] == true,
      screenAudio: media['screenAudio'] == true,
    );
  }

  final String sessionId;

  /// The media credential. NEVER shown, logged or persisted; redacted in
  /// [toString].
  final String token;

  /// Where the client connects (the client-facing media URL), from the server.
  final String url;

  /// How long the credential admits a FIRST connection. It does not bound how
  /// long one stays connected — the media server refreshes it after — so it is
  /// not a reason to reconnect; a new credential comes from `/join` again.
  final int expiresInSeconds;

  /// When the credential stops admitting a new connection.
  final DateTime expiresAt;

  /// What the server computed the holder may do — a display hint echoed from
  /// the session's `me`, never a client claim.
  final LiveParticipantRole role;

  /// What the credential permits publishing. `screenAudio` implies `screen`
  /// and is currently always false (Q56).
  final bool microphone;
  final bool screen;
  final bool screenAudio;

  /// The credential is deliberately absent: a grant's string form is safe to
  /// log, and never carries [token].
  @override
  String toString() =>
      'LiveMediaGrant(session: $sessionId, role: ${role.wire}, url: $url, '
      'expiresAt: ${expiresAt.toIso8601String()}, microphone: $microphone, '
      'screen: $screen, screenAudio: $screenAudio, token: <redacted>)';
}

/// Why a media connection dropped — the app's OWN vocabulary, never a
/// provider's type. [other] covers anything the named reasons do not.
enum LiveMediaDisconnectReason {
  /// The same account joined from another device; this connection was evicted.
  duplicateIdentity,

  /// The room is gone — the session ended, or its media room was reset.
  roomDeleted,

  /// A moderator removed this participant from the media room.
  participantRemoved,

  /// Anything else (a network fault the provider could not recover).
  other,
}

/// Where the media connection stands — a machine distinct from the session's
/// authority ([LiveSession]) and from HTTP refusals ([LiveException]). The two
/// are never one enum: the session says whether a session is live; this says
/// whether THIS device is carrying its audio.
///
/// `unavailable` (no media in this build) → `idle` (available, not joined) →
/// `connecting` → `connected` → `reconnecting` → `disconnected(reason)` /
/// `failed`. Reconnect policy and transitions belong to a later slice; this
/// slice only names the states.
sealed class LiveMediaState {
  const LiveMediaState();
}

/// No media in this build (the Unavailable default).
final class LiveMediaUnavailable extends LiveMediaState {
  const LiveMediaUnavailable();
}

/// Media is available, but this device has not joined.
final class LiveMediaIdle extends LiveMediaState {
  const LiveMediaIdle();
}

final class LiveMediaConnecting extends LiveMediaState {
  const LiveMediaConnecting();
}

final class LiveMediaConnected extends LiveMediaState {
  const LiveMediaConnected();
}

final class LiveMediaReconnecting extends LiveMediaState {
  const LiveMediaReconnecting();
}

/// The connection dropped; [reason] says why (and whether to come back).
final class LiveMediaDisconnected extends LiveMediaState {
  const LiveMediaDisconnected(this.reason);

  final LiveMediaDisconnectReason reason;

  @override
  bool operator ==(Object other) =>
      other is LiveMediaDisconnected && other.reason == reason;

  @override
  int get hashCode => reason.hashCode;
}

/// A connection attempt could not succeed.
final class LiveMediaFailed extends LiveMediaState {
  const LiveMediaFailed();
}

/// A refusal from the media seam — kept apart from [LiveException], which is
/// the HTTP/authority refusal. Minimal on purpose; the real media provider's
/// error surface is a later slice.
class LiveMediaException implements Exception {
  const LiveMediaException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'LiveMediaException($code): $message';
}

// ── Parsing helpers (the live-model convention; live.dart's are private) ─────

String _required(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.isNotEmpty) return value;
  throw FormatException('live media: missing "$key"');
}

int _int(Object? value) => value is num ? value.toInt() : 0;

DateTime _instant(Map<String, Object?> json, String key) {
  final value = json[key];
  final parsed = value is String ? DateTime.tryParse(value) : null;
  if (parsed == null) throw FormatException('live media: missing "$key"');
  return parsed;
}
