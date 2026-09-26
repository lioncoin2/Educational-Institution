/// Communities — groups a person belongs to, as the server keeps them
/// (backend/src/modules/communities/api, `/communities`).
///
/// What someone may do in a community is the server's answer, never this
/// app's: `me.capabilities`, `me.participation` and `me.operations` are what
/// the server says the viewer may do NOW — its lifecycle gate, its ceilings
/// and any grant already applied. Screens show an action if and only if the
/// server's answer holds it; nothing here reads an account's roles or
/// permissions.
///
/// Everything is parsed defensively. A status, standing, capability, act,
/// operation or link state this version does not know becomes `unknown` —
/// and an unknown capability, act or operation is dropped, so it can never
/// unlock anything. A newer server never breaks an older app; a list item
/// that cannot even be identified is skipped, never fatal to its page.
///
/// An invitation token is a secret: whoever holds it may join. It is read
/// from one answer only ([CreatedInvitation]) and no `toString` here ever
/// contains it.
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

/// What the viewer may do in a community that is not an act: never granted,
/// never a capability — reported beside the acts, and decided by the same
/// rules as the routes that perform them.
enum CommunityOperation {
  /// List the community's links, and revoke them.
  invitationsManage('community.invitations.manage'),

  /// See every grant; grant and revoke.
  grantsManage('community.grants.manage'),

  /// Hand the community to another member.
  ownershipTransfer('community.ownership.transfer'),

  /// End one's own membership.
  leave('community.leave'),
  unknown('unknown');

  const CommunityOperation(this.wire);

  final String wire;

  static CommunityOperation fromWire(Object? value) =>
      values.firstWhere((o) => o.wire == value, orElse: () => unknown);
}

/// The viewer in one community, as the server answered for them.
class CommunityMe {
  const CommunityMe({
    this.standing,
    this.joinedAt,
    this.capabilities = const {},
    this.participation = const {},
    this.operations = const {},
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
    operations: _known(
      json['operations'],
      CommunityOperation.fromWire,
      CommunityOperation.unknown,
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

  /// Allowed now — never containing [CommunityOperation.unknown]. Missing
  /// from an older server's answer: then nothing is allowed.
  final Set<CommunityOperation> operations;

  bool has(CommunityCapability capability) =>
      capability != CommunityCapability.unknown &&
      capabilities.contains(capability);

  bool takesPart(CommunityParticipation act) =>
      act != CommunityParticipation.unknown && participation.contains(act);

  bool allows(CommunityOperation operation) =>
      operation != CommunityOperation.unknown && operations.contains(operation);

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

// ── Invitation links ────────────────────────────────────────────────────────

/// Whether [token] has the shape every link token has: 43 characters of
/// `A–Z a–z 0–9 - _` (32 random bytes, base64url — the server's contract,
/// docs/architecture/communities.md). Anything else is no token at all; the
/// server answers it exactly like an unknown one.
bool isInvitationTokenShaped(String token) => _tokenShape.hasMatch(token);

final _tokenShape = RegExp(r'^[A-Za-z0-9_-]{43}$');

/// A link's state, derived by the server from the link and its clock:
/// REVOKED, then EXPIRED, then EXHAUSTED, then ACTIVE. ACTIVE promises
/// nothing about joining — a LOCKED community, or a creator who has lost the
/// right to invite, still refuses the link; only the answer to a join says.
enum InvitationState {
  active('ACTIVE'),
  expired('EXPIRED'),
  exhausted('EXHAUSTED'),
  revoked('REVOKED'),
  unknown('UNKNOWN');

  const InvitationState(this.wire);

  final String wire;

  static InvitationState fromWire(Object? value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => unknown);
}

/// One invitation link, as those who manage the community's links see it —
/// never its token, which the server keeps only as a hash.
class CommunityInvitation implements Sourced {
  const CommunityInvitation({
    required this.id,
    required this.createdAt,
    required this.expiresAt,
    required this.uses,
    required this.state,
    this.createdBy,
    this.maxUses,
    this.revokedAt,
    this.origin = DataOrigin.records,
  });

  /// Throws [FormatException] when it cannot be identified or dated.
  factory CommunityInvitation.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => CommunityInvitation(
    id: _required(json, 'id'),
    createdBy: _optional(json['createdBy']),
    createdAt: _instant(json, 'createdAt'),
    expiresAt: _instant(json, 'expiresAt'),
    maxUses: _optionalInt(json['maxUses']),
    uses: _int(json['uses']),
    state: InvitationState.fromWire(json['state']),
    revokedAt: _optionalInstant(json['revokedAt']),
    origin: origin,
  );

  final String id;

  /// Who made it: an account id, for telling the viewer's own links apart —
  /// never shown.
  final String? createdBy;
  final DateTime createdAt;
  final DateTime expiresAt;

  /// Null: no limit but the expiry.
  final int? maxUses;
  final int uses;
  final InvitationState state;
  final DateTime? revokedAt;

  @override
  final DataOrigin origin;
}

/// A link just made, and its token — the one answer that ever carries it.
/// Held only as long as it takes to show the link once; [toString] leaves
/// the token out.
class CreatedInvitation {
  const CreatedInvitation({required this.invitation, required this.token});

  /// Throws [FormatException] without a readable link or a token.
  factory CreatedInvitation.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) {
    final invitation = json['invitation'];
    if (invitation is! Map) {
      throw const FormatException('communities: missing "invitation"');
    }
    return CreatedInvitation(
      invitation: CommunityInvitation.fromJson(
        invitation.cast<String, Object?>(),
        origin: origin,
      ),
      token: _required(json, 'token'),
    );
  }

  final CommunityInvitation invitation;

  /// Whoever holds it may join: shown once, inside the link, and nowhere
  /// else.
  final String token;

  @override
  String toString() => 'CreatedInvitation(${invitation.id})';
}

class InvitationPage {
  const InvitationPage({required this.items, this.nextCursor});

  factory InvitationPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => InvitationPage(
    items: _list(
      json['items'],
      (item) => CommunityInvitation.fromJson(item, origin: origin),
    ),
    nextCursor: _optional(json['nextCursor']),
  );

  /// Newest first, every state.
  final List<CommunityInvitation> items;
  final String? nextCursor;
}

// ── Delegated capabilities ──────────────────────────────────────────────────

/// One capability the owner delegated to one member.
class CommunityGrant implements Sourced {
  const CommunityGrant({
    required this.grantId,
    required this.userId,
    required this.capability,
    required this.grantedAt,
    this.grantedBy,
    this.dormant = false,
    this.origin = DataOrigin.records,
  });

  /// Throws [FormatException] when it cannot be identified or dated.
  factory CommunityGrant.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => CommunityGrant(
    grantId: _required(json, 'grantId'),
    userId: _required(json, 'userId'),
    capability: CommunityCapability.fromWire(json['capability']),
    grantedAt: _instant(json, 'grantedAt'),
    grantedBy: _optional(json['grantedBy']),
    dormant: json['dormant'] == true,
    origin: origin,
  );

  final String grantId;

  /// Whose grant: an account id, never shown.
  final String userId;

  /// [CommunityCapability.unknown] for one this version does not know: it
  /// is kept (it can still be revoked) but stands for nothing.
  final CommunityCapability capability;
  final DateTime grantedAt;

  /// An account id, never shown.
  final String? grantedBy;

  /// Granted, but not in effect now: the holder lacks what the capability
  /// needs. The server keeps it, and it is in effect again once they have
  /// that back.
  final bool dormant;

  @override
  final DataOrigin origin;
}

class GrantPage {
  const GrantPage({required this.items, this.nextCursor});

  factory GrantPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => GrantPage(
    items: _list(
      json['items'],
      (item) => CommunityGrant.fromJson(item, origin: origin),
    ),
    nextCursor: _optional(json['nextCursor']),
  );

  final List<CommunityGrant> items;
  final String? nextCursor;
}

/// What one grant request did: the grants it [created], and those the member
/// already held, [unchanged].
class GrantChange {
  const GrantChange({this.created = const [], this.unchanged = const []});

  factory GrantChange.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => GrantChange(
    created: _list(
      json['created'],
      (item) => CommunityGrant.fromJson(item, origin: origin),
    ),
    unchanged: _list(
      json['unchanged'],
      (item) => CommunityGrant.fromJson(item, origin: origin),
    ),
  );

  final List<CommunityGrant> created;
  final List<CommunityGrant> unchanged;
}

// ── Refusals ────────────────────────────────────────────────────────────────

/// A refusal from `/communities`, with the server's stable code
/// (`communities.community_not_found`, `communities.capability_required`, …).
///
/// The getters sort refusals by what they are, never by why the server
/// decided them: which request a lock refuses, or who may remove whom, is
/// the server's to say.
class CommunityException implements Exception {
  const CommunityException(this.code, this.message, {this.details = const {}});

  final String code;
  final String message;

  /// What the server added to the refusal, as it sent it — the
  /// `retryAfterSeconds` of a rate limit, the `permission` or `field`
  /// concerned. Empty when it added nothing. Never shown as is, and left out
  /// of [toString].
  final Map<String, Object?> details;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  /// No such community — or, what the server answers alike, not the
  /// viewer's to see (any more).
  bool get isGone => code == 'communities.community_not_found';

  /// The community is the viewer's, but this part of it is not.
  bool get isForbidden =>
      code == 'communities.capability_required' ||
      code == 'identity.permission_denied';

  /// Too many requests of one kind for now. The server names every such
  /// limit `communities.too_many_…`.
  bool get isRateLimited => code.startsWith('communities.too_many_');

  /// How long the server asked to wait before trying again, when it said.
  Duration? get retryAfter => switch (details['retryAfterSeconds']) {
    final num seconds when seconds > 0 => Duration(seconds: seconds.ceil()),
    _ => null,
  };

  /// Another change to the same thing won the race: nothing was done.
  bool get isConflict =>
      code == 'communities.conflict' || code == 'communities.owner_conflict';

  /// Refused because the community is locked.
  bool get isLocked => code == 'communities.community_locked';

  /// The server could not serve the request just now.
  bool get isUnavailable => code == 'unavailable';

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

int? _optionalInt(Object? value) => value is num ? value.toInt() : null;

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
