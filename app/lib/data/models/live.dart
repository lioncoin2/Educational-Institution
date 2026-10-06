/// Live sessions — a community's live audio room, as the server keeps it
/// (backend/src/modules/live/api, `/live`).
///
/// READ-ONLY here. This foundation answers one question for a community: is a
/// session running now, and who hosts it. Joining, speaking, the roster and
/// hearing are **media** — a separate seam that is Unavailable in this build
/// (lib/data/media/live_media_seams.dart); none of it is modelled here.
///
/// Everything is parsed defensively, as communities are: a session state or a
/// role this version does not know becomes `unknown`, and a field it cannot
/// read is simply not read. What the viewer may do is the server's `me`
/// answer — nothing here reads an account's roles or permissions.
library;

import 'data_origin.dart';

/// Whether a session is running now, or has ended. The server sends only these.
enum LiveSessionState {
  live('live'),
  ended('ended'),
  unknown('UNKNOWN');

  const LiveSessionState(this.wire);

  final String wire;

  static LiveSessionState fromWire(Object? value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => unknown);
}

/// The viewer's role in a session, as the server computed it.
enum LiveParticipantRole {
  moderator('moderator'),
  speaker('speaker'),
  listener('listener'),
  unknown('unknown');

  const LiveParticipantRole(this.wire);

  final String wire;

  static LiveParticipantRole fromWire(Object? value) =>
      values.firstWhere((r) => r.wire == value, orElse: () => unknown);
}

/// The viewer in one live session, as the server answered for them — only the
/// facts this read-only foundation needs. Whether they may join, raise a hand
/// or present is media, and is not read here.
class LiveMe {
  const LiveMe({
    this.role = LiveParticipantRole.unknown,
    this.isHost = false,
    this.canModerate = false,
  });

  factory LiveMe.fromJson(Map<String, Object?> json) => LiveMe(
    role: LiveParticipantRole.fromWire(json['role']),
    isHost: json['isHost'] == true,
    canModerate: json['canModerate'] == true,
  );

  final LiveParticipantRole role;

  /// The viewer started this session.
  final bool isHost;

  /// The viewer moderates it (host or a granted moderator). The server's
  /// answer, never worked out here.
  final bool canModerate;
}

/// One live session as the viewer sees it — the `session` of
/// `GET /live/communities/:id/sessions/current`. Never carries media.
class LiveSession implements Sourced {
  const LiveSession({
    required this.id,
    required this.communityId,
    required this.state,
    required this.hostUserId,
    required this.startedAt,
    required this.speakerCount,
    required this.me,
    this.origin = DataOrigin.records,
  });

  /// Throws [FormatException] when it cannot be identified, placed or dated.
  factory LiveSession.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => LiveSession(
    id: _required(json, 'id'),
    communityId: _required(json, 'communityId'),
    state: LiveSessionState.fromWire(json['state']),
    hostUserId: _required(json, 'hostUserId'),
    startedAt: _instant(json, 'startedAt'),
    speakerCount: _int(json['speakerCount']),
    me: json['me'] is Map
        ? LiveMe.fromJson((json['me']! as Map).cast<String, Object?>())
        : const LiveMe(),
    origin: origin,
  );

  final String id;
  final String communityId;
  final LiveSessionState state;

  /// The host's account id — for telling sessions apart, never shown in place
  /// of a name (names are the directory's, not read here).
  final String hostUserId;
  final DateTime startedAt;

  /// How many hold the floor now, as the server counts them.
  final int speakerCount;
  final LiveMe me;

  @override
  final DataOrigin origin;

  /// Running now. The current-session read treats anything else as "none".
  bool get isLive => state == LiveSessionState.live;
}

/// A refusal from `/live`, with the server's stable code. Getters sort refusals
/// by what they are, never by why the server decided them.
class LiveException implements Exception {
  const LiveException(this.code, this.message, {this.details = const {}});

  final String code;
  final String message;
  final Map<String, Object?> details;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  /// No such session or community — or, what the server answers alike, not the
  /// viewer's to see.
  bool get isGone =>
      code == 'live.session_not_found' || code == 'live.community_not_found';

  bool get isForbidden =>
      code == 'communities.capability_required' ||
      code == 'identity.permission_denied' ||
      code == 'live.not_a_moderator';

  bool get isUnavailable => code == 'unavailable';

  @override
  String toString() => 'LiveException($code): $message';
}

// ── Parsing helpers (the communities.dart convention) ───────────────────────

String _required(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.isNotEmpty) return value;
  throw FormatException('live: missing "$key"');
}

int _int(Object? value) => value is num ? value.toInt() : 0;

DateTime _instant(Map<String, Object?> json, String key) {
  final value = json[key];
  final parsed = value is String ? DateTime.tryParse(value) : null;
  if (parsed == null) throw FormatException('live: missing "$key"');
  return parsed;
}
