import 'dart:convert';
import 'dart:math';

import '../../../app/app_config.dart';
import '../../models/communities.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// In-memory stand-in for `/communities`, for the demo build and for widget
/// tests.
///
/// It keeps the server's rules, so screens built against it behave the same
/// against the real API: a community the viewer is not in does not exist;
/// the roster is a capability, refused to a plain member; `me` is what the
/// viewer may do NOW, with the lifecycle applied, and every route here
/// decides by the same predicate `me` reports; pages are cut by opaque
/// cursors, 30 communities or 50 members or links at a time. A rule the
/// server holds only provisionally is copied as such — marked "PROVISIONAL,
/// Qnn — the server's table" — and changes when the server's does.
///
/// The largest community has 30,000 members, and its roster is never held:
/// each page is built from its position when it is asked for, so walking a
/// page costs a page — exactly as the server's keyset pages do. Someone who
/// leaves or is removed is remembered as a position, never by building the
/// rows around it.
///
/// Links and joining are here too. One community the viewer is not in
/// ([invitedId]) comes with links whose tokens are fixed, so the demo can
/// open one: [demoActiveToken] joins it, and the other demo tokens are
/// refused as the server refuses an expired, a revoked and a used-up link.
///
/// Everything in it is invented and marked as such.
class MockCommunityRepository implements CommunityRepository {
  MockCommunityRepository({
    this.latency = AppConfig.fakeLatency,
    this.communityPageSize = 30,
    this.memberPageSize = 50,
    this.invitationPageSize = 50,
    this.clock = DateTime.now,
  }) {
    _seed();
  }

  final Duration latency;

  /// The server's default page sizes; a test may cut smaller pages to walk.
  final int communityPageSize;
  final int memberPageSize;
  final int invitationPageSize;

  /// "Now", for what the server reads off its clock: when a link expires,
  /// when someone joined. A test may fix it.
  final DateTime Function() clock;

  /// The demo's signed-in person — the same one as the demo's messaging.
  static const String viewer = 'mock-student';

  /// Who founded — and owns — every community the viewer does not own: row
  /// 0 of its roster.
  static const String founder = 'mock-teacher';

  /// An OPEN community the viewer is a plain member of: its chat is readable,
  /// its roster is not theirs to see.
  static const String openId = 'mock-community-tajweed';

  /// A LOCKED one the viewer is a member of.
  static const String lockedId = 'mock-community-review';

  /// One the viewer owns: every capability is theirs.
  static const String ownedId = 'mock-community-family';

  /// One whose owner delegated `community.members.view` to the viewer.
  static const String delegatedId = 'mock-community-evening';

  /// The institution-wide one: 30,000 members, roster delegated to the viewer.
  static const String largeId = 'mock-community-institute';

  /// One the viewer is not in: absent from the list, "not found" to a read —
  /// until they join it with [demoActiveToken].
  static const String invitedId = 'mock-community-dawn';

  /// A link to [invitedId] that admits whoever holds it. Demo data only: a
  /// real token is random, and shown once.
  static const String demoActiveToken =
      'DemoInvitation_Active_000000000000000000000';

  /// A link to [invitedId] past its expiry.
  static const String demoExpiredToken =
      'DemoInvitation_Expired_00000000000000000000';

  /// A link to [invitedId] its maker revoked.
  static const String demoRevokedToken =
      'DemoInvitation_Revoked_00000000000000000000';

  /// A link to [invitedId] used as many times as it allows.
  static const String demoExhaustedToken =
      'DemoInvitation_Exhausted_000000000000000000';

  static final DateTime _start = DateTime.utc(2026, 9, 1, 6);

  final Map<String, _MockCommunity> _communities = {};
  final Map<String, _MockInvitation> _invitationsByToken = {};
  final Random _random = Random.secure();
  int _membersBuilt = 0;

  /// Numbers links and grants, in the order they were made.
  int _serial = 0;

  /// How many roster rows this repository has ever built. Rows are built
  /// per page, on request — never a whole roster.
  int get membersBuilt => _membersBuilt;

  /// The viewer's `me` in [communityId] as it stands, at once — null where
  /// they are not a member. Not part of the contract: it is how the demo's
  /// messaging answers a community's chat by the community (wired in
  /// app_providers.dart), as the server's messaging asks the community.
  CommunityMe? meIn(String communityId) {
    final c = _communities[communityId];
    return c != null && c.viewerIsMember ? c.view().me : null;
  }

  @override
  Future<CommunityPage> communities({String? cursor}) async {
    await _wait();
    final mine = _communities.values.where((c) => c.viewerIsMember).toList()
      ..sort((a, b) => b.joinedAt.compareTo(a.joinedAt));
    final start = cursor == null
        ? 0
        : min(_position(cursor, 'c1'), mine.length);
    final end = min(start + communityPageSize, mine.length);
    return CommunityPage(
      items: [for (final c in mine.sublist(start, end)) c.view()],
      nextCursor: end < mine.length ? _cursor('c1', end) : null,
    );
  }

  @override
  Future<Community> community(String communityId) async {
    await _wait();
    return _find(communityId).view();
  }

  @override
  Future<CommunityMemberPage> members(
    String communityId, {
    String? cursor,
  }) async {
    await _wait();
    final c = _find(communityId);
    if (!c.view().canViewMembers) {
      throw _capabilityRequired(CommunityCapability.membersView);
    }
    // The cursor is a position among every row there ever was: rows that
    // have gone are passed over, so it means the same row however many go.
    final start = cursor == null
        ? 0
        : min(_position(cursor, 'm1:${c.id}'), c.rowCount);
    final items = <CommunityMember>[];
    var next = start;
    for (; next < c.rowCount && items.length < memberPageSize; next++) {
      if (!c.removedRows.contains(next)) items.add(_member(c, next));
    }
    _membersBuilt += items.length;
    return CommunityMemberPage(
      items: items,
      nextCursor: c.membersFrom(next) > 0 ? _cursor('m1:${c.id}', next) : null,
    );
  }

  // ── Invitation links ────────────────────────────────────────────────────

  @override
  Future<CreatedInvitation> createInvitation(String communityId) async {
    await _wait();
    final c = _find(communityId);
    if (!c.viewerHolds(CommunityCapability.membersInvite)) {
      throw _capabilityRequired(CommunityCapability.membersInvite);
    }
    // Held, but closed by the lifecycle: PROVISIONAL, Q46 — the server's
    // table (no new links while LOCKED).
    if (!c.view().me.has(CommunityCapability.membersInvite)) {
      throw _locked(CommunityCapability.membersInvite);
    }
    final now = _now();
    final invitation = _add(
      c,
      createdBy: viewer,
      createdAt: now,
      // PROVISIONAL, Q48 — the server's default terms: seven days, and no
      // limit on uses.
      expiresAt: now.add(const Duration(days: 7)),
    );
    return CreatedInvitation(
      invitation: invitation.view(now),
      token: invitation.token,
    );
  }

  @override
  Future<InvitationPage> invitations(
    String communityId, {
    String? cursor,
  }) async {
    await _wait();
    final c = _find(communityId);
    _requireLinkManagement(c);
    // Keyset, as the server's: a cursor names the last link shown, so a link
    // made meanwhile never shifts a page that follows.
    final before = cursor == null ? null : _position(cursor, 'i1:${c.id}');
    final newestFirst = [
      for (final i in c.invitations.reversed)
        if (before == null || i.serial < before) i,
    ];
    final page = newestFirst.take(invitationPageSize).toList();
    final now = _now();
    return InvitationPage(
      items: [for (final i in page) i.view(now)],
      nextCursor: newestFirst.length > page.length
          ? _cursor('i1:${c.id}', page.last.serial)
          : null,
    );
  }

  @override
  Future<CommunityInvitation> revokeInvitation(
    String communityId,
    String invitationId,
  ) async {
    await _wait();
    final c = _find(communityId);
    _requireLinkManagement(c);
    final invitation = c.invitations
        .where((i) => i.id == invitationId)
        .firstOrNull;
    if (invitation == null) {
      throw const CommunityException(
        'communities.invitation_not_found',
        'No such invitation link in this community.',
      );
    }
    final now = _now();
    // Once revoked, always revoked, and still then: the first time stands.
    invitation.revokedAt ??= now;
    return invitation.view(now);
  }

  @override
  Future<Community> join(String token) async {
    await _wait();
    // The server's order (invitation.use-cases.ts, then the store's redeem).
    // A token of the wrong shape is never even looked up.
    final invitation = isInvitationTokenShaped(token)
        ? _invitationsByToken[token]
        : null;
    if (invitation == null) {
      throw const CommunityException(
        'communities.invitation_invalid',
        'This invitation link is not valid.',
      );
    }
    final c = _communities[invitation.communityId]!;
    switch (c.stint) {
      case _Stint.active:
        // A member already: the community, and no use of the link.
        return c.view();
      case _Stint.removed:
        // PROVISIONAL, Q49 — the server's table: removed means back only
        // by a manager, never by a link.
        throw const CommunityException(
          'communities.rejoin_requires_manager',
          'You were removed from this community; only its managers can add '
              'you back.',
        );
      case _Stint.none || _Stint.left:
        break;
    }
    switch (invitation.stateAt(_now())) {
      case InvitationState.revoked:
        throw const CommunityException(
          'communities.invitation_revoked',
          'This link was revoked.',
        );
      case InvitationState.expired:
        throw const CommunityException(
          'communities.invitation_expired',
          'This link expired.',
        );
      case InvitationState.exhausted:
        throw const CommunityException(
          'communities.invitation_exhausted',
          'This link has been used as many times as it allows.',
        );
      case InvitationState.active || InvitationState.unknown:
        break;
    }
    // PROVISIONAL, Q46 — the server's table: a LOCKED community takes
    // nobody, and its links are suspended, neither used nor revoked.
    if (!c.acceptsMembers) {
      throw const CommunityException(
        'communities.community_locked',
        'This community is locked; its links work again once it is unlocked.',
      );
    }
    invitation.uses += 1;
    _begin(c);
    return c.view();
  }

  // ── Membership ──────────────────────────────────────────────────────────

  @override
  Future<void> removeMember(String communityId, String userId) async {
    await _wait();
    final c = _find(communityId);
    if (!c.view().me.has(CommunityCapability.membersRemove)) {
      throw _capabilityRequired(CommunityCapability.membersRemove);
    }
    final row = _activeRow(c, userId);
    if (row == null) {
      throw const CommunityException(
        'communities.member_not_found',
        'That account is not a member of this community.',
      );
    }
    // PROVISIONAL, Q42 — the server's table: never the owner. Asked first,
    // so an owner naming themself is told this.
    if (row == c.ownerRow) {
      throw const CommunityException(
        'communities.owner_not_removable',
        'The owner of a community cannot be removed from it.',
      );
    }
    // PROVISIONAL, Q49 — the server's table: removing oneself would close
    // the way back by link; that is a leave.
    if (row == c.viewerRow) {
      throw const CommunityException(
        'communities.cannot_remove_self',
        'You cannot remove yourself; leave the community instead.',
      );
    }
    // PROVISIONAL, Q44 — the server's table (R6): a delegate removes nobody
    // holding a capability the delegate does not.
    if (!c.owned && !c.grantedTo(userId).every(c.viewerHolds)) {
      throw const CommunityException(
        'communities.member_holds_more_capabilities',
        'This member holds a capability you do not; only the owner can '
            'remove them.',
      );
    }
    c.removedRows.add(row);
    c.endGrantsOf(userId);
  }

  @override
  Future<void> leave(String communityId) async {
    await _wait();
    final c = _find(communityId);
    // PROVISIONAL, Q42 — the server's table: the owner hands the community
    // over before leaving it.
    if (!c.mayLeave) {
      throw const CommunityException(
        'communities.owner_cannot_leave',
        'The owner cannot leave a community; ownership must be handed over '
            'first.',
      );
    }
    _end(c, removed: false);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  @override
  Future<Community> lock(String communityId) =>
      _setStatus(communityId, CommunityStatus.locked);

  @override
  Future<Community> unlock(String communityId) =>
      _setStatus(communityId, CommunityStatus.open);

  Future<Community> _setStatus(
    String communityId,
    CommunityStatus status,
  ) async {
    await _wait();
    final c = _find(communityId);
    // PROVISIONAL, Q46 — the server's table: the owner or a holder of a
    // delegated `community.lock`, whatever the status (so it can unlock).
    if (!c.view().me.has(CommunityCapability.lock)) {
      throw _capabilityRequired(CommunityCapability.lock);
    }
    changeStatus(c.id, status);
    return c.view();
  }

  // ── Delegated capabilities and ownership ────────────────────────────────

  @override
  Future<GrantPage> grants(
    String communityId, {
    required String userId,
    String? cursor,
  }) async {
    await _wait();
    final c = _find(communityId);
    // PROVISIONAL, Q45 — the server's table: the owner sees every grant;
    // anyone else their own, and nobody else's.
    final visible = c.managesGrants || userId == viewer;
    final held = visible
        ? (c.grants.where((g) => g.active && g.userId == userId).toList()
            ..sort((a, b) => a.capability.wire.compareTo(b.capability.wire)))
        : const <_MockGrant>[];
    final scope = 'g1:${c.id}:$userId';
    final start = cursor == null
        ? 0
        : min(_position(cursor, scope), held.length);
    final end = min(start + _grantPageSize, held.length);
    return GrantPage(
      items: [for (final g in held.sublist(start, end)) g.view()],
      nextCursor: end < held.length ? _cursor(scope, end) : null,
    );
  }

  /// The server's default page of grants.
  static const _grantPageSize = 50;

  @override
  Future<GrantChange> grant(
    String communityId, {
    required String userId,
    required Set<CommunityCapability> capabilities,
  }) async {
    await _wait();
    // The route's own shape: one to seven capabilities of the vocabulary.
    if (capabilities.isEmpty ||
        capabilities.contains(CommunityCapability.unknown)) {
      throw const CommunityException(
        'bad_request',
        'One to seven distinct capabilities of the vocabulary.',
      );
    }
    final c = _find(communityId);
    // PROVISIONAL, Q44 — the server's table (R1): only the owner grants.
    if (!c.managesGrants) throw _notOwner;
    // PROVISIONAL, Q44 — the server's table (R3, R5): an ACTIVE member,
    // neither the owner nor oneself, on an active account that holds the
    // capabilities' ceiling — here, one of the mock's teachers
    // ([_mayModerate]). Every reason is refused alike.
    final row = _activeRow(c, userId);
    if (row == null ||
        row == c.ownerRow ||
        row == c.viewerRow ||
        !_accountActive(c, row) ||
        !_mayModerate(userId)) {
      throw const CommunityException(
        'communities.grantee_ineligible',
        'That account cannot hold these capabilities in this community.',
      );
    }
    final now = _now();
    final created = <CommunityGrant>[];
    final unchanged = <CommunityGrant>[];
    for (final capability in CommunityCapability.values) {
      if (!capabilities.contains(capability)) continue;
      final held = c.grants
          .where(
            (g) => g.active && g.userId == userId && g.capability == capability,
          )
          .firstOrNull;
      if (held != null) {
        unchanged.add(held.view());
        continue;
      }
      final grant = _grant(c, userId, capability, by: viewer, at: now);
      created.add(grant.view());
    }
    return GrantChange(created: created, unchanged: unchanged);
  }

  @override
  Future<void> revokeGrant(String communityId, String grantId) async {
    await _wait();
    final c = _find(communityId);
    // PROVISIONAL, Q44 — the server's table (R1): only the owner revokes.
    if (!c.managesGrants) throw _notOwner;
    final grant = c.grants.where((g) => g.grantId == grantId).firstOrNull;
    if (grant == null) {
      throw const CommunityException(
        'communities.grant_not_found',
        'No such grant in this community.',
      );
    }
    grant.active = false;
  }

  @override
  Future<Community> transferOwnership(String communityId, String userId) async {
    await _wait();
    final c = _find(communityId);
    // PROVISIONAL, Q42 — the server's table: the owner hands it over.
    if (!c.transfers) throw _notOwner;
    // Naming the owner — the viewer — changes nothing, as on the server.
    if (userId == viewer) return c.view();
    final row = _activeRow(c, userId);
    // PROVISIONAL, Q42, Q44 — the server's table: an ACTIVE member on an
    // active account that holds the ceiling of ownership — here, one of the
    // mock's teachers ([_mayModerate]). Every reason is refused alike.
    if (row == null || !_accountActive(c, row) || !_mayModerate(userId)) {
      throw const CommunityException(
        'communities.owner_ineligible',
        'That account cannot own this community.',
      );
    }
    // PROVISIONAL, Q42 — the server's table: the new owner's grants end, and
    // the former owner is a member holding none.
    c
      ..endGrantsOf(userId)
      ..endGrantsOf(viewer)
      ..ownerRow = row;
    return c.view();
  }

  // ── What the server would do meanwhile — for tests and demonstrations ────

  /// Locks or unlocks, moving the lifecycle version on a real change only —
  /// as the server does. Returns the version now.
  int changeStatus(String communityId, CommunityStatus status) {
    final c = _communities[communityId]!;
    if (c.status != status) {
      c
        ..status = status
        ..lifecycleVersion += 1;
    }
    return c.lifecycleVersion;
  }

  /// The viewer's stint ends — they left or, with [removed], a manager
  /// removed them: from now on the community is, to them, one that does not
  /// exist, and whatever was delegated to them has ended with the stint.
  void endMembership(String communityId, {bool removed = false}) =>
      _end(_communities[communityId]!, removed: removed);

  /// A new stint for the viewer, starting now — with nothing delegated yet.
  void restoreMembership(String communityId) =>
      _begin(_communities[communityId]!);

  /// The owner changed what it delegates to the viewer.
  void delegate(String communityId, Set<CommunityCapability> capabilities) {
    final c = _communities[communityId]!;
    for (final grant in c.grants) {
      if (grant.active &&
          grant.userId == viewer &&
          !capabilities.contains(grant.capability)) {
        grant.active = false;
      }
    }
    for (final capability in capabilities) {
      if (!c.viewerHolds(capability)) {
        _grant(c, viewer, capability, by: _userIdAt(c, c.ownerRow), at: _now());
      }
    }
  }

  // ── The pretend server's insides ────────────────────────────────────────

  _MockCommunity _find(String id) {
    final c = _communities[id];
    if (c == null || !c.viewerIsMember) {
      throw const CommunityException(
        'communities.community_not_found',
        'No such community.',
      );
    }
    return c;
  }

  void _requireLinkManagement(_MockCommunity c) {
    if (!c.managesLinks) {
      throw _capabilityRequired(CommunityCapability.membersInvite);
    }
  }

  /// The viewer's stint begins — or, already running, starts over now.
  void _begin(_MockCommunity c) {
    if (!c.viewerIsMember) {
      final row = c.viewerRow;
      if (row == null) {
        // Never in it before: the newest row of its roster.
        c
          ..viewerRow = c.rowCount
          ..rowCount += 1;
      } else {
        c.removedRows.remove(row);
      }
      c.stint = _Stint.active;
    }
    c.joinedAt = _now();
  }

  void _end(_MockCommunity c, {required bool removed}) {
    if (c.viewerIsMember) {
      c.removedRows.add(c.viewerRow!);
      c.endGrantsOf(viewer);
    }
    c.stint = removed ? _Stint.removed : _Stint.left;
  }

  _MockGrant _grant(
    _MockCommunity c,
    String userId,
    CommunityCapability capability, {
    required String by,
    required DateTime at,
  }) {
    final grant = _MockGrant(
      grantId: '${c.id}-grant-${++_serial}',
      userId: userId,
      capability: capability,
      grantedAt: at,
      grantedBy: by,
    );
    c.grants.add(grant);
    return grant;
  }

  _MockInvitation _add(
    _MockCommunity c, {
    required String createdBy,
    required DateTime createdAt,
    required DateTime expiresAt,
    String? token,
    int? maxUses,
    int uses = 0,
    DateTime? revokedAt,
  }) {
    final serial = ++_serial;
    final invitation = _MockInvitation(
      id: '${c.id}-invitation-$serial',
      serial: serial,
      communityId: c.id,
      token: token ?? _newToken(),
      createdBy: createdBy,
      createdAt: createdAt,
      expiresAt: expiresAt,
      maxUses: maxUses,
      uses: uses,
      revokedAt: revokedAt,
    );
    c.invitations.add(invitation);
    _invitationsByToken[invitation.token] = invitation;
    return invitation;
  }

  /// 43 characters of the base64url alphabet from a secure source — the
  /// shape of the server's 32 random bytes.
  String _newToken() {
    const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    String token;
    do {
      token = String.fromCharCodes([
        for (var i = 0; i < 43; i++)
          alphabet.codeUnitAt(_random.nextInt(alphabet.length)),
      ]);
    } while (_invitationsByToken.containsKey(token));
    return token;
  }

  /// Row [index] of [c]'s roster, oldest member first, as the server orders
  /// it — computed, not stored.
  CommunityMember _member(_MockCommunity c, int index) {
    final userId = _userIdAt(c, index);
    if (userId == viewer) {
      return CommunityMember(
        userId: viewer,
        displayName: 'طالب تجريبي',
        active: true,
        joinedAt: c.joinedAt,
        origin: DataOrigin.mock,
      );
    }
    if (userId == founder) {
      return CommunityMember(
        userId: founder,
        displayName: 'الأستاذ عبدالله',
        active: true,
        joinedAt: c.createdAt,
        origin: DataOrigin.mock,
      );
    }
    final String? displayName;
    if (_isTeacherRow(index)) {
      // Numbered in roster order, two to every 25 rows.
      final teacher = index ~/ 25 * 2 + (index % 25 == 2 ? 0 : 1);
      displayName = _teacherNames[teacher % _teacherNames.length];
    } else if (index % 29 == 7) {
      // Now and then someone the directory has no name for.
      displayName = null;
    } else {
      displayName =
          '${_givenNames[index % _givenNames.length]} '
          '${_familyNames[(index ~/ _givenNames.length) % _familyNames.length]}';
    }
    return CommunityMember(
      userId: userId,
      displayName: displayName,
      active: _accountActive(c, index),
      // A minute apart, in the roster's order.
      joinedAt: c.rosterStart.add(Duration(minutes: index)),
      origin: DataOrigin.mock,
    );
  }

  /// Whose row [index] is. Row 0 is the owner the community was founded
  /// with: the viewer, where they own it, and [founder] everywhere else.
  static String _userIdAt(_MockCommunity c, int index) {
    if (index == c.viewerRow) return viewer;
    if (index == 0) return founder;
    if (_isTeacherRow(index)) return '$founder-$index';
    return '${c.id}-member-$index';
  }

  /// The row of [userId] while they are a member of [c] — null for anyone
  /// else, without building a row.
  static int? _activeRow(_MockCommunity c, String userId) {
    final int? index;
    if (userId == viewer) {
      index = c.viewerRow;
    } else if (userId == founder) {
      index = 0;
    } else if (userId.startsWith('$founder-')) {
      index = int.tryParse(userId.substring(founder.length + 1));
    } else if (userId.startsWith('${c.id}-member-')) {
      index = int.tryParse(userId.substring('${c.id}-member-'.length));
    } else {
      index = null;
    }
    if (index == null || index < 0 || index >= c.rowCount) return null;
    if (c.removedRows.contains(index)) return null;
    // Round trip: '-member-07', or a teacher's position under the member
    // prefix, names nobody.
    return _userIdAt(c, index) == userId ? index : null;
  }

  /// Two in every 25 members teach: the 3rd and the 10th of each 25.
  static bool _isTeacherRow(int index) => const {2, 9}.contains(index % 25);

  /// Whether [userId]'s account holds the ceiling a capability or ownership
  /// asks — `communities.moderate` on the server (PROVISIONAL, Q44), which
  /// no student's account holds. This mock knows no roles, so it answers in
  /// its own fiction: its teachers' accounts do, and nobody else's. What the
  /// seeds give the viewer is data, not a grant made through a route.
  static bool _mayModerate(String userId) => userId.startsWith(founder);

  /// Whether the ACCOUNT on row [index] can sign in (not the membership,
  /// which every row has).
  static bool _accountActive(_MockCommunity c, int index) =>
      index == 0 ||
      index == c.viewerRow ||
      _isTeacherRow(index) ||
      index % 23 != 11;

  /// Invented names for invented members.
  static const _givenNames = [
    'أحمد',
    'يوسف',
    'مريم',
    'فاطمة',
    'عمر',
    'خديجة',
    'إبراهيم',
    'سارة',
    'عبدالرحمن',
    'عائشة',
    'حمزة',
    'زينب',
    'بلال',
    'أسماء',
    'معاذ',
    'هاجر',
  ];
  static const _familyNames = [
    'الأنصاري',
    'القرشي',
    'الهاشمي',
    'التميمي',
    'الزهراني',
    'العتيبي',
    'الشمري',
    'الحربي',
    'المالكي',
    'الغامدي',
    'الدوسري',
  ];
  static const _teacherNames = [
    'الأستاذة عائشة',
    'الأستاذ يوسف',
    'الأستاذة مريم',
    'الأستاذ حمزة',
  ];

  /// Opaque to the caller, like the server's; one this repository did not
  /// issue for this list is refused as the server refuses it. A list that
  /// shrank meanwhile simply ends — as a keyset past the last row does.
  static String _cursor(String scope, int position) =>
      base64Url.encode(utf8.encode('$scope:$position'));

  static int _position(String cursor, String scope) {
    String decoded;
    try {
      decoded = utf8.decode(base64Url.decode(cursor));
    } on FormatException {
      throw _cursorInvalid;
    }
    final position = decoded.startsWith('$scope:')
        ? int.tryParse(decoded.substring(scope.length + 1))
        : null;
    if (position == null || position <= 0) throw _cursorInvalid;
    return position;
  }

  static const _cursorInvalid = CommunityException(
    'communities.cursor_invalid',
    'That page cursor is not valid.',
  );

  static CommunityException _capabilityRequired(
    CommunityCapability capability,
  ) => CommunityException(
    'communities.capability_required',
    'You do not hold this capability in this community.',
    details: {'act': capability.wire},
  );

  static CommunityException _locked(CommunityCapability capability) =>
      CommunityException(
        'communities.community_locked',
        'This community is locked.',
        details: {'act': capability.wire},
      );

  static const _notOwner = CommunityException(
    'communities.not_community_owner',
    'Only the owner of this community can do this.',
  );

  DateTime _now() => clock().toUtc();

  Future<void> _wait() =>
      latency == Duration.zero ? Future.value() : Future.delayed(latency);

  void _seed() {
    for (final c in [
      _MockCommunity(
        id: openId,
        title: 'مجتمع طلاب التجويد',
        memberCount: 24,
        createdAt: _start,
        joinedAt: _start.add(const Duration(days: 19)),
      ),
      _MockCommunity(
        id: ownedId,
        title: 'مجتمع أسرة الحفظ',
        memberCount: 12,
        createdAt: _start.add(const Duration(days: 14)),
        joinedAt: _start.add(const Duration(days: 14)),
        owned: true,
      ),
      _MockCommunity(
        id: delegatedId,
        title: 'مجتمع حلقة المساء',
        memberCount: 64,
        createdAt: _start.add(const Duration(days: 2)),
        joinedAt: _start.add(const Duration(days: 9)),
      ),
      _MockCommunity(
        id: lockedId,
        title: 'مجتمع المراجعة الأسبوعية',
        memberCount: 18,
        createdAt: _start.add(const Duration(days: 1)),
        joinedAt: _start.add(const Duration(days: 4)),
        status: CommunityStatus.locked,
        lifecycleVersion: 2,
      ),
      _MockCommunity(
        id: largeId,
        title: 'مجتمع طلاب المعهد',
        memberCount: 30000,
        createdAt: _start.subtract(const Duration(days: 30)),
        joinedAt: _start,
      ),
      _MockCommunity(
        id: invitedId,
        title: 'مجتمع حلقة الفجر',
        memberCount: 40,
        createdAt: _start.add(const Duration(days: 3)),
        joinedAt: _start.add(const Duration(days: 3)),
        member: false,
      ),
    ]) {
      _communities[c.id] = c;
    }

    // What the owners delegated: the roster, to the viewer, in two
    // communities; and in the viewer's own, the roster to one teacher.
    for (final id in [delegatedId, largeId]) {
      _grant(
        _communities[id]!,
        viewer,
        CommunityCapability.membersView,
        by: founder,
        at: _start.add(const Duration(days: 10)),
      );
    }
    final owned = _communities[ownedId]!;
    _grant(
      owned,
      _userIdAt(owned, 2),
      CommunityCapability.membersView,
      by: viewer,
      at: _start.add(const Duration(days: 15)),
    );

    // Links, dated from now so their states hold whenever the demo runs:
    // two the viewer made for its own community, and four to the one it is
    // not in, one of them still admitting.
    final now = _now();
    DateTime ago(int days) => now.subtract(Duration(days: days));
    DateTime ahead(int days) => now.add(Duration(days: days));
    _add(
      owned,
      createdBy: viewer,
      createdAt: ago(20),
      expiresAt: ago(13),
      uses: 9,
    );
    _add(
      owned,
      createdBy: viewer,
      createdAt: ago(2),
      expiresAt: ahead(5),
      maxUses: 30,
      uses: 4,
    );
    final invited = _communities[invitedId]!;
    _add(
      invited,
      token: demoExpiredToken,
      createdBy: founder,
      createdAt: ago(12),
      expiresAt: ago(5),
      uses: 6,
    );
    _add(
      invited,
      token: demoExhaustedToken,
      createdBy: founder,
      createdAt: ago(4),
      expiresAt: ahead(3),
      maxUses: 5,
      uses: 5,
    );
    _add(
      invited,
      token: demoRevokedToken,
      createdBy: founder,
      createdAt: ago(3),
      expiresAt: ahead(4),
      uses: 1,
      revokedAt: ago(1),
    );
    _add(
      invited,
      token: demoActiveToken,
      createdBy: founder,
      createdAt: ago(1),
      expiresAt: ahead(29),
      uses: 2,
    );
  }
}

/// The viewer's latest stint in a community, if any.
enum _Stint { none, active, left, removed }

class _MockCommunity {
  _MockCommunity({
    required this.id,
    required this.title,
    required int memberCount,
    required this.createdAt,
    required this.joinedAt,
    bool owned = false,
    bool member = true,
    this.status = CommunityStatus.open,
    this.lifecycleVersion = 1,
  }) : rowCount = memberCount,
       rosterStart = joinedAt,
       viewerRow = member ? (owned ? 0 : 1) : null,
       stint = member ? _Stint.active : _Stint.none;

  final String id;
  final String title;
  final DateTime createdAt;

  /// Rows are dated from here, however the viewer's own stint moves.
  final DateTime rosterStart;

  /// When the viewer's current (or last) stint began.
  DateTime joinedAt;
  CommunityStatus status;
  int lifecycleVersion;
  _Stint stint;

  /// Every row the roster ever had, by position, oldest first — computed on
  /// request, never stored: those gone are only remembered as positions.
  int rowCount;
  final Set<int> removedRows = {};

  /// The viewer's row; null while they were never in it.
  int? viewerRow;

  /// The owner's row: the one the community was founded with, until handed
  /// over.
  int ownerRow = 0;

  final List<_MockGrant> grants = [];

  /// Oldest first.
  final List<_MockInvitation> invitations = [];

  /// What LOCKED closes: PROVISIONAL, Q46 — the server's table
  /// (lifecycle.ts): new members, posting, starting live.
  static const _closedWhenLocked = {
    CommunityCapability.membersInvite,
    CommunityCapability.chatPost,
    CommunityCapability.liveStart,
  };

  bool get viewerIsMember => stint == _Stint.active;

  int get memberCount => rowCount - removedRows.length;

  /// How many members there are from row [index] on.
  int membersFrom(int index) =>
      (rowCount - index) - removedRows.where((row) => row >= index).length;

  bool get owned => viewerRow != null && viewerRow == ownerRow;

  /// Whether anyone new may join: PROVISIONAL, Q46 — the server's table (an
  /// OPEN community only; LOCKED, or a status it does not know, closes it).
  bool get acceptsMembers => status == CommunityStatus.open;

  /// What the viewer holds on some basis, before the lifecycle: the owner
  /// every capability, anyone else what was delegated to them.
  bool viewerHolds(CommunityCapability capability) =>
      capability != CommunityCapability.unknown &&
      (owned || grantedTo(MockCommunityRepository.viewer).contains(capability));

  Set<CommunityCapability> grantedTo(String userId) => {
    for (final g in grants)
      if (g.active && g.userId == userId) g.capability,
  };

  void endGrantsOf(String userId) {
    for (final g in grants) {
      if (g.userId == userId) g.active = false;
    }
  }

  // The operations — each one predicate, shared by `me` and its route.

  /// PROVISIONAL, Q48 — the server's table: whoever makes links lists and
  /// revokes them, and keeps doing so while LOCKED (Q46).
  bool get managesLinks => viewerHolds(CommunityCapability.membersInvite);

  /// PROVISIONAL, Q44 — the server's table (R1): the owner's own.
  bool get managesGrants => owned;

  /// PROVISIONAL, Q42 — the server's table: the owner's own.
  bool get transfers => owned;

  /// PROVISIONAL, Q42 — the server's table: anyone but the owner.
  bool get mayLeave => viewerIsMember && !owned;

  Community view() => Community(
    id: id,
    title: title,
    status: status,
    lifecycleVersion: lifecycleVersion,
    memberCount: memberCount,
    createdAt: createdAt,
    me: CommunityMe(
      standing: owned ? CommunityStanding.owner : CommunityStanding.member,
      joinedAt: joinedAt,
      capabilities: {
        for (final c in CommunityCapability.values)
          if (viewerHolds(c) &&
              (status == CommunityStatus.open ||
                  !_closedWhenLocked.contains(c)))
            c,
      },
      // Reading the chat and joining live stay open while LOCKED.
      participation: {
        for (final p in CommunityParticipation.values)
          if (p != CommunityParticipation.unknown) p,
      },
      operations: {
        if (managesLinks) CommunityOperation.invitationsManage,
        if (managesGrants) CommunityOperation.grantsManage,
        if (transfers) CommunityOperation.ownershipTransfer,
        if (mayLeave) CommunityOperation.leave,
      },
    ),
    origin: DataOrigin.mock,
  );
}

class _MockInvitation {
  _MockInvitation({
    required this.id,
    required this.serial,
    required this.communityId,
    required this.token,
    required this.createdBy,
    required this.createdAt,
    required this.expiresAt,
    this.maxUses,
    this.uses = 0,
    this.revokedAt,
  });

  final String id;

  /// The order links were made in: newest, highest.
  final int serial;
  final String communityId;
  final String token;
  final String createdBy;
  final DateTime createdAt;
  final DateTime expiresAt;
  final int? maxUses;
  int uses;
  DateTime? revokedAt;

  /// Derived, never stored, in the server's order (domain/invitation.ts):
  /// REVOKED, then EXPIRED (now ≥ expiry), then EXHAUSTED, then ACTIVE.
  InvitationState stateAt(DateTime now) {
    if (revokedAt != null) return InvitationState.revoked;
    if (!now.isBefore(expiresAt)) return InvitationState.expired;
    final limit = maxUses;
    if (limit != null && uses >= limit) return InvitationState.exhausted;
    return InvitationState.active;
  }

  CommunityInvitation view(DateTime now) => CommunityInvitation(
    id: id,
    createdBy: createdBy,
    createdAt: createdAt,
    expiresAt: expiresAt,
    maxUses: maxUses,
    uses: uses,
    state: stateAt(now),
    revokedAt: revokedAt,
    origin: DataOrigin.mock,
  );
}

class _MockGrant {
  _MockGrant({
    required this.grantId,
    required this.userId,
    required this.capability,
    required this.grantedAt,
    required this.grantedBy,
  });

  final String grantId;
  final String userId;
  final CommunityCapability capability;
  final DateTime grantedAt;
  final String grantedBy;

  /// Ended by a revocation, a removal, a leave or a transfer — kept, so
  /// ending it again is known and changes nothing.
  bool active = true;

  /// Never dormant: this mock knows no account's ceilings (Q45).
  CommunityGrant view() => CommunityGrant(
    grantId: grantId,
    userId: userId,
    capability: capability,
    grantedAt: grantedAt,
    grantedBy: grantedBy,
    origin: DataOrigin.mock,
  );
}
