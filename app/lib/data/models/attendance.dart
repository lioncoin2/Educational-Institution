/// Attendance snapshots — a server-taken observation of who Live held
/// connected at a press, as the backend keeps it
/// (backend/src/modules/attendance/api, `/attendance`).
///
/// RECORD-ONLY here (attendance.md §17, P9). This foundation models the one
/// result a press returns: the two connection counts, and who recorded it.
/// Viewing past snapshots, their participant lists and paging are a separate
/// slice and are deliberately not modelled here.
///
/// Everything is parsed defensively, as communities and live are: a required
/// field the app cannot read is a [FormatException], never a silent default on
/// an id or a date. A snapshot speaks only of connections — there is no
/// "present", "absent" or ratio anywhere (§12).
library;

import 'data_origin.dart';

/// Who took a snapshot: a stable account id and the display name the server
/// resolved at view time (null when it could not). Never an email.
class SnapshotRecorder {
  const SnapshotRecorder({required this.userId, this.displayName});

  factory SnapshotRecorder.fromJson(Map<String, Object?> json) =>
      SnapshotRecorder(
        userId: _required(json, 'userId'),
        displayName: json['displayName'] is String
            ? json['displayName']! as String
            : null,
      );

  final String userId;
  final String? displayName;
}

/// One recorded attendance snapshot — the header the POST returns
/// (attendance.md §15.3). Counts only; the participant list is paged apart by
/// a later slice and is deliberately not here.
class SnapshotView implements Sourced {
  const SnapshotView({
    required this.id,
    required this.communityId,
    required this.liveSessionId,
    required this.recordedBy,
    required this.observationRule,
    required this.observationStartedAt,
    required this.observedAt,
    required this.recordedAt,
    required this.connectedCount,
    required this.connectingCount,
    this.origin = DataOrigin.records,
  });

  /// Throws [FormatException] when it cannot be identified, placed or dated.
  factory SnapshotView.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => SnapshotView(
    id: _required(json, 'id'),
    communityId: _required(json, 'communityId'),
    liveSessionId: _required(json, 'liveSessionId'),
    recordedBy: _recorder(json['recordedBy']),
    observationRule: _required(json, 'observationRule'),
    observationStartedAt: _instant(json, 'observationStartedAt'),
    observedAt: _instant(json, 'observedAt'),
    recordedAt: _instant(json, 'recordedAt'),
    connectedCount: _int(json['connectedCount']),
    connectingCount: _int(json['connectingCount']),
    origin: origin,
  );

  final String id;
  final String communityId;
  final String liveSessionId;
  final SnapshotRecorder recordedBy;

  /// The rule the observation was taken under — 'provider_registry_v1' today
  /// (§5.2). Carried, never branched on here.
  final String observationRule;
  final DateTime observationStartedAt;
  final DateTime observedAt;
  final DateTime recordedAt;

  /// How many the provider held CONNECTED at the press.
  final int connectedCount;

  /// How many it held CONNECTING.
  final int connectingCount;

  @override
  final DataOrigin origin;
}

/// How the media provider held a participant at the press (§6.2 I6) — the only
/// vocabulary a snapshot speaks, never "present", "absent" or a verdict. A wire
/// value this version does not know becomes [unknown].
enum SnapshotConnection {
  connected('CONNECTED'),
  connecting('CONNECTING'),
  unknown('UNKNOWN');

  const SnapshotConnection(this.wire);

  final String wire;

  static SnapshotConnection fromWire(Object? value) =>
      values.firstWhere((c) => c.wire == value, orElse: () => unknown);
}

/// One participant on a snapshot's entries page (§15.3): an account id, the
/// name the server resolved at view time (null if unknown), and how the
/// provider held them. Never an email; never a "present" field.
class SnapshotParticipant implements Sourced {
  const SnapshotParticipant({
    required this.userId,
    required this.connection,
    this.displayName,
    this.origin = DataOrigin.records,
  });

  /// Throws [FormatException] when it cannot be identified.
  factory SnapshotParticipant.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => SnapshotParticipant(
    userId: _required(json, 'userId'),
    displayName: _optional(json['displayName']),
    connection: SnapshotConnection.fromWire(json['connection']),
    origin: origin,
  );

  /// For telling rows apart — never shown in place of a name.
  final String userId;
  final String? displayName;
  final SnapshotConnection connection;

  @override
  final DataOrigin origin;
}

/// A keyset page of a community's snapshots (§15.1), newest first. [nextCursor]
/// is the server's opaque token, handed back as it came — never built or read.
class SnapshotPage {
  const SnapshotPage({required this.items, this.nextCursor});

  factory SnapshotPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => SnapshotPage(
    items: _list(
      json['items'],
      (item) => SnapshotView.fromJson(item, origin: origin),
    ),
    nextCursor: _optional(json['nextCursor']),
  );

  final List<SnapshotView> items;

  /// Opaque: handed back as it came, never built or read.
  final String? nextCursor;
}

/// A keyset page of one snapshot's participants (§15.1), ascending by account
/// id. [nextCursor] is opaque, as [SnapshotPage.nextCursor] is.
class SnapshotParticipantPage {
  const SnapshotParticipantPage({required this.items, this.nextCursor});

  factory SnapshotParticipantPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => SnapshotParticipantPage(
    items: _list(
      json['items'],
      (item) => SnapshotParticipant.fromJson(item, origin: origin),
    ),
    nextCursor: _optional(json['nextCursor']),
  );

  final List<SnapshotParticipant> items;
  final String? nextCursor;
}

/// A refusal from `/attendance`, with the server's stable code. Getters sort
/// refusals by what they are, never by why the server decided them.
class AttendanceException implements Exception {
  const AttendanceException(this.code, this.message, {this.details = const {}});

  final String code;
  final String message;
  final Map<String, Object?> details;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  /// No such session — or, what the server answers alike, not the caller's to
  /// record for (§11.3: a 404 masks "no standing").
  bool get sessionNotFound => code == 'attendance.session_not_found';

  /// No such community — or, alike, not the caller's to view (404, §11.3).
  bool get communityNotFound => code == 'attendance.community_not_found';

  /// No such snapshot — unknown, invisible or not permitted, all alike (404).
  bool get snapshotNotFound => code == 'attendance.snapshot_not_found';

  /// A page cursor the server could not decode (422).
  bool get cursorInvalid => code == 'attendance.cursor_invalid';

  /// A member of the community whom no record basis permits (403).
  bool get notAllowed => code == 'attendance.not_allowed';

  /// The live session is not running (412); nothing was recorded.
  bool get sessionNotLive => code == 'attendance.session_not_live';

  /// The community is not open (412).
  bool get communityNotOpen => code == 'attendance.community_not_open';

  /// Pressing too fast (429). See [retryAfterSeconds].
  bool get rateLimited => code == 'attendance.too_many_snapshots';

  /// The observation could not be taken (503); nothing stored, and retrying
  /// with the same key is safe — it takes a fresh observation (§15.2, S3).
  bool get observationUnavailable =>
      code == 'attendance.observation_unavailable';

  /// Attendance's own store or the directory could not be read (503).
  bool get isUnavailable => code == 'attendance.unavailable';

  /// The server's hint for how long to wait before retrying, when it sent one.
  int? get retryAfterSeconds {
    final value = details['retryAfterSeconds'];
    return value is num ? value.toInt() : null;
  }

  @override
  String toString() => 'AttendanceException($code): $message';
}

// ── Parsing helpers (the live.dart / communities.dart convention) ───────────

SnapshotRecorder _recorder(Object? value) {
  if (value is Map) {
    return SnapshotRecorder.fromJson(value.cast<String, Object?>());
  }
  throw const FormatException('attendance: missing "recordedBy"');
}

String _required(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.isNotEmpty) return value;
  throw FormatException('attendance: missing "$key"');
}

int _int(Object? value) => value is num ? value.toInt() : 0;

String? _optional(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;

DateTime _instant(Map<String, Object?> json, String key) {
  final value = json[key];
  final parsed = value is String ? DateTime.tryParse(value) : null;
  if (parsed == null) throw FormatException('attendance: missing "$key"');
  return parsed;
}

/// Items that cannot be read are skipped, never fatal to the list.
List<T> _list<T>(Object? value, T Function(Map<String, Object?> json) parse) {
  if (value is! List) return const [];
  final items = <T>[];
  for (final item in value) {
    if (item is! Map) continue;
    try {
      items.add(parse(item.cast<String, Object?>()));
    } on FormatException {
      continue;
    } on TypeError {
      continue;
    }
  }
  return items;
}
