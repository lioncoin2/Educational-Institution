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

/// Why a live session ended, as the server records it (`endReason`). A reason a
/// newer server adds is `unknown`; the session is over regardless. (The
/// realtime layer carries its own copy for the ended frame — the two converge
/// when the live feature consumes frames, a later slice.)
enum LiveSessionEndReason {
  moderator('moderator'),
  idle('idle'),
  communityClosed('community_closed'),
  unknown('unknown');

  const LiveSessionEndReason(this.wire);

  final String wire;

  static LiveSessionEndReason fromWire(Object? value) =>
      values.firstWhere((r) => r.wire == value, orElse: () => unknown);
}

/// The lifecycle of the viewer's own raised hand (live.md §5), as the server
/// reports it in `me.hand`. A state a newer server adds is `unknown`.
enum SpeakerRequestState {
  pending('pending'),
  granted('granted'),
  declined('declined'),
  revoked('revoked'),
  withdrawn('withdrawn'),
  expired('expired'),
  unknown('unknown');

  const SpeakerRequestState(this.wire);

  final String wire;

  static SpeakerRequestState fromWire(Object? value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => unknown);
}

/// The viewer's own open hand — the `me.hand` of a live session: the id of
/// their speaker request and its state. The moderators' hand QUEUE (names,
/// timestamps) is a separate read this foundation does not model.
class LiveMyHand {
  const LiveMyHand({required this.requestId, required this.state});

  factory LiveMyHand.fromJson(Map<String, Object?> json) => LiveMyHand(
    requestId: _required(json, 'requestId'),
    state: SpeakerRequestState.fromWire(json['state']),
  );

  final String requestId;
  final SpeakerRequestState state;
}

/// The viewer in one live session, as the server answered for them (`me`).
/// Every flag is the server's own decision — a display hint it re-checks on
/// every command — and none is worked out here; nothing reads an account's
/// roles or permissions. "May join" and "may present" are the server's answers,
/// not media participation (which is a separate seam).
class LiveMe {
  const LiveMe({
    this.role = LiveParticipantRole.unknown,
    this.isHost = false,
    this.canJoin = false,
    this.canRaiseHand = false,
    this.canModerate = false,
    this.canEnd = false,
    this.canPresent = false,
    this.presenting = false,
    this.hand,
  });

  factory LiveMe.fromJson(Map<String, Object?> json) => LiveMe(
    role: LiveParticipantRole.fromWire(json['role']),
    isHost: json['isHost'] == true,
    canJoin: json['canJoin'] == true,
    canRaiseHand: json['canRaiseHand'] == true,
    canModerate: json['canModerate'] == true,
    canEnd: json['canEnd'] == true,
    canPresent: json['canPresent'] == true,
    presenting: json['presenting'] == true,
    hand: json['hand'] is Map
        ? LiveMyHand.fromJson((json['hand']! as Map).cast<String, Object?>())
        : null,
  );

  final LiveParticipantRole role;

  /// The viewer started this session.
  final bool isHost;

  /// `/join` would admit them now — the server's answer (joining is media).
  final bool canJoin;

  /// They may raise a hand now.
  final bool canRaiseHand;

  /// They moderate it (host or a granted moderator). The server's answer,
  /// never worked out here.
  final bool canModerate;

  /// They may end the session (any of its moderators).
  final bool canEnd;

  /// They may claim a presenter slot now (Q56).
  final bool canPresent;

  /// They hold an open presenter grant — by right or delegated (Q56).
  final bool presenting;

  /// Their open hand, or null.
  final LiveMyHand? hand;
}

/// One live session as the viewer sees it — the backend `LiveSessionView`
/// (`GET /live/communities/:id/sessions/current` and `GET /live/sessions/:id`).
/// Never carries media: a join credential, the connected roster and hearing
/// are a separate seam, not modelled here.
class LiveSession implements Sourced {
  const LiveSession({
    required this.id,
    required this.communityId,
    required this.state,
    required this.hostUserId,
    required this.startedAt,
    required this.speakerCount,
    required this.me,
    this.stateVersion = 0,
    this.participantCap = 0,
    this.presenterUserIds = const [],
    this.endedAt,
    this.endReason,
    this.moderation,
    this.origin = DataOrigin.records,
  });

  /// Throws [FormatException] when it cannot be identified, placed or dated.
  /// Every other field is read defensively (the communities convention): an
  /// unknown enum becomes `unknown`, a missing count or flag takes its benign
  /// default, a nullable field stays null, and a field it cannot read is not
  /// read. No value is computed here — the session is the server's answer.
  factory LiveSession.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => LiveSession(
    id: _required(json, 'id'),
    communityId: _required(json, 'communityId'),
    state: LiveSessionState.fromWire(json['state']),
    stateVersion: _int(json['stateVersion']),
    hostUserId: _required(json, 'hostUserId'),
    startedAt: _instant(json, 'startedAt'),
    endedAt: _instantOrNull(json, 'endedAt'),
    endReason: json['endReason'] == null
        ? null
        : LiveSessionEndReason.fromWire(json['endReason']),
    speakerCount: _int(json['speakerCount']),
    participantCap: _int(json['participantCap']),
    presenterUserIds: _stringList(json['presenterUserIds']),
    me: json['me'] is Map
        ? LiveMe.fromJson((json['me']! as Map).cast<String, Object?>())
        : const LiveMe(),
    moderation: json['moderation'] is Map
        ? LiveModeration.fromJson(
            (json['moderation']! as Map).cast<String, Object?>(),
          )
        : null,
    origin: origin,
  );

  final String id;
  final String communityId;
  final LiveSessionState state;

  /// The server's version of the session's mutable state. A realtime hint is
  /// applied only when it is newer; this model never compares it (a later
  /// slice reconciles).
  final int stateVersion;

  /// The host's account id — for telling sessions apart, never shown in place
  /// of a name (names are the directory's, not read here).
  final String hostUserId;
  final DateTime startedAt;

  /// When it ended; null while it is live.
  final DateTime? endedAt;

  /// Why it ended; null while it is live.
  final LiveSessionEndReason? endReason;

  /// How many hold the floor now, as the server counts them.
  final int speakerCount;

  /// The media room's participant cap, as the server sets it.
  final int participantCap;

  /// The current presenters (Q56): up to two, in the server's order. Plural;
  /// the two-presenter limit is the server's, never enforced here.
  final List<String> presenterUserIds;

  final LiveMe me;

  /// Present for the session's moderators only; null otherwise.
  final LiveModeration? moderation;

  @override
  final DataOrigin origin;

  /// Running now. The current-session read treats anything else as "none".
  bool get isLive => state == LiveSessionState.live;
}

/// The moderators' counters for a session — present only in a moderator's
/// view (`moderation`). Counts are the server's; nothing is computed here.
class LiveModeration {
  const LiveModeration({
    required this.pendingHands,
    required this.violations,
    this.lastViolationAt,
  });

  factory LiveModeration.fromJson(Map<String, Object?> json) => LiveModeration(
    pendingHands: _int(json['pendingHands']),
    violations: _int(json['violations']),
    lastViolationAt: _instantOrNull(json, 'lastViolationAt'),
  );

  /// Capped by the server: that value means "this many or more".
  final int pendingHands;
  final int violations;
  final DateTime? lastViolationAt;
}

/// A speaker's connection as last observed, shown beside a granted hand — a
/// display hint, never truth. A value a newer server adds is `unknown`.
enum LiveObservedMedia {
  connected('connected'),
  notConnected('not_connected'),
  unknown('unknown');

  const LiveObservedMedia(this.wire);

  final String wire;

  static LiveObservedMedia fromWire(Object? value) =>
      values.firstWhere((m) => m.wire == value, orElse: () => unknown);
}

/// Which hands the moderators' page asks for: the queue (`pending`) or who
/// holds the floor (`granted`). A query filter only — distinct from a hand's
/// own lifecycle `SpeakerRequestState`, which has more values.
enum LiveHandsFilter {
  pending('pending'),
  granted('granted');

  const LiveHandsFilter(this.wire);

  final String wire;
}

/// One hand on the moderators' page — a speaker request with its owner's name
/// from the directory and, for a granted hand, their last-observed connection.
/// Identity and timestamps are the server's; the name is a display value.
class LiveHand {
  const LiveHand({
    required this.id,
    required this.sessionId,
    required this.userId,
    required this.state,
    required this.requestedAt,
    this.grantedAt,
    this.decidedAt,
    this.displayName,
    this.media,
  });

  /// Throws [FormatException] when it cannot be identified, placed or dated.
  /// Everything else is read defensively (the live model convention).
  factory LiveHand.fromJson(Map<String, Object?> json) => LiveHand(
    id: _required(json, 'id'),
    sessionId: _required(json, 'sessionId'),
    userId: _required(json, 'userId'),
    state: SpeakerRequestState.fromWire(json['state']),
    requestedAt: _instant(json, 'requestedAt'),
    grantedAt: _instantOrNull(json, 'grantedAt'),
    decidedAt: _instantOrNull(json, 'decidedAt'),
    displayName: json['displayName'] is String
        ? json['displayName']! as String
        : null,
    media: json['media'] == null
        ? null
        : LiveObservedMedia.fromWire(json['media']),
  );

  final String id;
  final String sessionId;
  final String userId;
  final SpeakerRequestState state;
  final DateTime requestedAt;

  /// When the floor was given; null while pending or if passed over.
  final DateTime? grantedAt;

  /// When a moderator decided it; null while pending.
  final DateTime? decidedAt;

  /// The owner's display name as the directory resolved it; null if absent.
  final String? displayName;

  /// A granted hand's last-observed connection; null when the server sends none.
  final LiveObservedMedia? media;
}

/// A keyset page of the moderators' hands (`{items, nextCursor}`). `nextCursor`
/// is opaque — pass it back for the next page; null on the last.
class LiveHandsPage implements Sourced {
  const LiveHandsPage({
    required this.items,
    required this.nextCursor,
    this.origin = DataOrigin.records,
  });

  factory LiveHandsPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) {
    final items = json['items'];
    return LiveHandsPage(
      items: items is List
          ? [
              for (final item in items)
                if (item is Map)
                  LiveHand.fromJson(item.cast<String, Object?>()),
            ]
          : const [],
      nextCursor: json['nextCursor'] is String
          ? json['nextCursor']! as String
          : null,
      origin: origin,
    );
  }

  final List<LiveHand> items;

  /// Opaque; null on the last page.
  final String? nextCursor;

  @override
  final DataOrigin origin;
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

/// A nullable instant: null when absent, null (not a throw) when unreadable —
/// an optional timestamp the server may legitimately omit (`endedAt` while
/// live, `lastViolationAt` with no violation).
DateTime? _instantOrNull(Map<String, Object?> json, String key) {
  final value = json[key];
  return value is String ? DateTime.tryParse(value) : null;
}

/// The string elements of a wire list, defensively — a non-list is empty, and
/// a non-string element is skipped rather than crashing the parse.
List<String> _stringList(Object? value) => value is List
    ? [
        for (final item in value)
          if (item is String) item,
      ]
    : const [];
