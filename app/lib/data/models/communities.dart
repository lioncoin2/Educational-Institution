/// Communities — groups a person belongs to, as the server keeps them
/// (backend/src/modules/communities/api, `/communities`).
///
/// What someone may do in a community is the server's answer, never this
/// app's: `me.capabilities` and `me.participation` are what the server says
/// the viewer may do NOW — its lifecycle gate, its ceilings and any grant
/// already applied. Screens show an action if and only if the server's
/// answer holds it; nothing here reads an account's roles or permissions.
///
/// Everything is parsed defensively. A status, standing, capability or act
/// this version does not know becomes `unknown` — and an unknown capability
/// or act is dropped, so it can never unlock anything. A newer server never
/// breaks an older app; a list item that cannot even be identified is
/// skipped, never fatal to its page.
library;

import 'data_origin.dart';

/// OPEN or LOCKED. What LOCKED closes is the server's to say (through
/// `me`); the app only shows that it is.
enum CommunityStatus {
  open('OPEN'),
  locked('LOCKED'),
  unknown('UNKNOWN');

  const CommunityStatus(this.wire);

  final String wire;

  static CommunityStatus fromWire(Object? value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => unknown);
}

/// The viewer's belonging: the one owner, or a member. Not a role, not a
/// capability.
enum CommunityStanding {
  owner('OWNER'),
  member('MEMBER'),
  unknown('UNKNOWN');

  const CommunityStanding(this.wire);

  final String wire;

  static CommunityStanding fromWire(Object? value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => unknown);
}

/// What an owner holds, and may delegate to a member one grant at a time.
enum CommunityCapability {
  membersView('community.members.view'),
  membersInvite('community.members.invite'),
  membersRemove('community.members.remove'),
  lock('community.lock'),
  chatPost('community.chat.post'),
  liveStart('community.live.start'),
  liveModerate('community.live.moderate'),
  unknown('unknown');

  const CommunityCapability(this.wire);

  final String wire;

  static CommunityCapability fromWire(Object? value) =>
      values.firstWhere((c) => c.wire == value, orElse: () => unknown);
}

/// What ACTIVE membership alone allows — never granted.
enum CommunityParticipation {
  view('community.view'),
  chatRead('community.chat.read'),
  liveJoin('community.live.join'),
  liveRaiseHand('community.live.raise_hand'),
  unknown('unknown');

  const CommunityParticipation(this.wire);

  final String wire;

  static CommunityParticipation fromWire(Object? value) =>
      values.firstWhere((p) => p.wire == value, orElse: () => unknown);
}

/// The viewer in one community, as the server answered for them.
class CommunityMe {
  const CommunityMe({
    this.standing,
    this.joinedAt,
    this.capabilities = const {},
    this.participation = const {},
  });

  /// `standing: null` is the server saying "not a member: reading on the
  /// oversight basis". A missing or unreadable standing is [unknown] — it is
  /// never taken for oversight.
  factory CommunityMe.fromJson(Map<String, Object?> json) => CommunityMe(
    standing: json.containsKey('standing') && json['standing'] == null
        ? null
        : CommunityStanding.fromWire(json['standing']),
    joinedAt: _optionalInstant(json['joinedAt']),
    capabilities: _known(
      json['capabilities'],
      CommunityCapability.fromWire,
      CommunityCapability.unknown,
    ),
    participation: _known(
      json['participation'],
      CommunityParticipation.fromWire,
      CommunityParticipation.unknown,
    ),
  );

  /// Null only for oversight (see [isOversight]).
  final CommunityStanding? standing;

  /// When the current stint began; null for oversight.
  final DateTime? joinedAt;

  /// Effective now — never containing [CommunityCapability.unknown].
  final Set<CommunityCapability> capabilities;

  /// Effective now — never containing [CommunityParticipation.unknown].
  final Set<CommunityParticipation> participation;

  bool has(CommunityCapability capability) =>
      capability != CommunityCapability.unknown &&
      capabilities.contains(capability);

  bool takesPart(CommunityParticipation act) =>
      act != CommunityParticipation.unknown && participation.contains(act);

  /// Seen without membership, on the server's oversight basis.
  bool get isOversight => standing == null;
}

/// One community as the viewer sees it — `GET /communities/:id`, and each
/// item of `GET /communities`.
class Community implements Sourced {
  const Community({
    required this.id,
    required this.title,
    required this.status,
    required this.lifecycleVersion,
    required this.memberCount,
    required this.createdAt,
    required this.me,
    this.origin = DataOrigin.records,
  });

  /// Throws [FormatException] when it cannot be identified, named or dated.
  factory Community.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => Community(
    id: _required(json, 'id'),
    title: _required(json, 'title'),
    status: CommunityStatus.fromWire(json['status']),
    lifecycleVersion: _int(json['lifecycleVersion']),
    memberCount: _int(json['memberCount']),
    createdAt: _instant(json, 'createdAt'),
    me: json['me'] is Map
        ? CommunityMe.fromJson((json['me']! as Map).cast<String, Object?>())
        : const CommunityMe(standing: CommunityStanding.unknown),
    origin: origin,
  );

  final String id;
  final String title;
  final CommunityStatus status;

  /// Moves forward with every lock and unlock — the one version a frame
  /// (`community.locked` / `community.unlocked`) can be compared with.
  final int lifecycleVersion;

  /// The server's maintained count; the roster itself is paged.
  final int memberCount;
  final DateTime createdAt;
  final CommunityMe me;

  @override
  final DataOrigin origin;

  bool get isLocked => status == CommunityStatus.locked;

  /// The community's chat is readable by the viewer now.
  bool get canOpenChat => me.takesPart(CommunityParticipation.chatRead);

  /// The roster is the viewer's to see now.
  bool get canViewMembers => me.has(CommunityCapability.membersView);
}

class CommunityPage {
  const CommunityPage({required this.items, this.nextCursor});

  factory CommunityPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => CommunityPage(
    items: _list(
      json['items'],
      (item) => Community.fromJson(item, origin: origin),
    ),
    nextCursor: _optional(json['nextCursor']),
  );

  final List<Community> items;

  /// Opaque: handed back as it came, never built or read.
  final String? nextCursor;
}

/// One row of a community's roster. Never an email, never how or by whom
/// someone joined — the server sends neither.
class CommunityMember implements Sourced {
  const CommunityMember({
    required this.userId,
    required this.active,
    required this.joinedAt,
    this.displayName,
    this.origin = DataOrigin.records,
  });

  /// Throws [FormatException] when it cannot be identified or dated.
  factory CommunityMember.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => CommunityMember(
    userId: _required(json, 'userId'),
    displayName: _optional(json['displayName']),
    active: json['active'] == true,
    joinedAt: _instant(json, 'joinedAt'),
    origin: origin,
  );

  /// For telling rows apart — never shown in place of a name.
  final String userId;
  final String? displayName;

  /// The ACCOUNT is active — not the membership, which every row has.
  final bool active;
  final DateTime joinedAt;

  @override
  final DataOrigin origin;
}

class CommunityMemberPage {
  const CommunityMemberPage({required this.items, this.nextCursor});

  factory CommunityMemberPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => CommunityMemberPage(
    items: _list(
      json['items'],
      (item) => CommunityMember.fromJson(item, origin: origin),
    ),
    nextCursor: _optional(json['nextCursor']),
  );

  final List<CommunityMember> items;
  final String? nextCursor;
}

/// A refusal from `/communities`, with the server's stable code
/// (`communities.community_not_found`, `communities.capability_required`, …).
class CommunityException implements Exception {
  const CommunityException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  /// No such community — or, what the server answers alike, not the
  /// viewer's to see (any more).
  bool get isGone => code == 'communities.community_not_found';

  /// The community is the viewer's, but this part of it is not.
  bool get isForbidden =>
      code == 'communities.capability_required' ||
      code == 'identity.permission_denied';

  @override
  String toString() => 'CommunityException($code): $message';
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

String _required(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.isNotEmpty) return value;
  throw FormatException('communities: missing "$key"');
}

String? _optional(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;

int _int(Object? value) => value is num ? value.toInt() : 0;

DateTime _instant(Map<String, Object?> json, String key) {
  final value = json[key];
  final parsed = value is String ? DateTime.tryParse(value) : null;
  if (parsed == null) throw FormatException('communities: missing "$key"');
  return parsed;
}

DateTime? _optionalInstant(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;

/// The values this version knows, as a set: anything unknown is dropped, so
/// it can neither unlock an action nor be mistaken for one.
Set<T> _known<T>(Object? value, T Function(Object?) fromWire, T unknown) {
  if (value is! List) return const {};
  return Set.unmodifiable({
    for (final item in value)
      if (fromWire(item) case final known when known != unknown) known,
  });
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
  return List.unmodifiable(items);
}
