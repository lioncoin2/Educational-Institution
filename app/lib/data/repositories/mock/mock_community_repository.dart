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
/// viewer may do NOW, with the lifecycle applied (a LOCKED community takes
/// no new members, no posts and no new live sessions — the server's
/// provisional table, backend/src/modules/communities/domain/lifecycle.ts);
/// pages are cut by opaque cursors, 30 communities or 50 members at a time.
///
/// The largest community has 30,000 members, and its roster is never held:
/// each page is built from its position when it is asked for, so walking a
/// page costs a page — exactly as the server's keyset pages do.
///
/// Everything in it is invented and marked as such.
class MockCommunityRepository implements CommunityRepository {
  MockCommunityRepository({
    this.latency = AppConfig.fakeLatency,
    this.communityPageSize = 30,
    this.memberPageSize = 50,
  }) {
    _seed();
  }

  final Duration latency;

  /// The server's default page sizes; a test may cut smaller pages to walk.
  final int communityPageSize;
  final int memberPageSize;

  /// The demo's signed-in person — the same one as the demo's messaging.
  static const String viewer = 'mock-student';

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

  static final DateTime _start = DateTime.utc(2026, 9, 1, 6);

  final Map<String, _MockCommunity> _communities = {};
  int _membersBuilt = 0;

  /// How many roster rows this repository has ever built. Rows are built
  /// per page, on request — never a whole roster.
  int get membersBuilt => _membersBuilt;

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
      throw const CommunityException(
        'communities.capability_required',
        'Only the owner and those it delegated to may see the roster.',
      );
    }
    final start = cursor == null
        ? 0
        : min(_position(cursor, 'm1:${c.id}'), c.memberCount);
    final end = min(start + memberPageSize, c.memberCount);
    final items = [for (var i = start; i < end; i++) _member(c, i)];
    _membersBuilt += items.length;
    return CommunityMemberPage(
      items: items,
      nextCursor: end < c.memberCount ? _cursor('m1:${c.id}', end) : null,
    );
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

  /// The viewer's stint ends (they left, or were removed): from now on the
  /// community is, to them, one that does not exist.
  void endMembership(String communityId) =>
      _communities[communityId]!.viewerIsMember = false;

  /// A new stint for the viewer, starting now.
  void restoreMembership(String communityId) => _communities[communityId]!
    ..viewerIsMember = true
    ..joinedAt = DateTime.now().toUtc();

  /// The owner changed what it delegates to the viewer.
  void delegate(String communityId, Set<CommunityCapability> capabilities) =>
      _communities[communityId]!.delegated = {...capabilities};

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

  /// Row [index] of [c]'s roster, oldest member first, as the server orders
  /// it — computed, not stored.
  CommunityMember _member(_MockCommunity c, int index) {
    final viewerIndex = c.owned ? 0 : 1;
    if (index == viewerIndex) {
      return CommunityMember(
        userId: viewer,
        displayName: 'طالب تجريبي',
        active: true,
        joinedAt: c.joinedAt,
        origin: DataOrigin.mock,
      );
    }
    if (index == 0) {
      return CommunityMember(
        userId: 'mock-teacher',
        displayName: 'الأستاذ عبدالله',
        active: true,
        joinedAt: c.createdAt,
        origin: DataOrigin.mock,
      );
    }
    return CommunityMember(
      userId: '${c.id}-member-$index',
      // Now and then someone the directory has no name for.
      displayName: index % 29 == 7
          ? null
          : '${_givenNames[index % _givenNames.length]} '
                '${_familyNames[(index ~/ _givenNames.length) % _familyNames.length]}',
      active: index % 23 != 11,
      // Everyone after the viewer joined after them, a minute apart.
      joinedAt: c.joinedAt.add(Duration(minutes: index)),
      origin: DataOrigin.mock,
    );
  }

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
        delegated: {CommunityCapability.membersView},
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
        delegated: {CommunityCapability.membersView},
      ),
    ]) {
      _communities[c.id] = c;
    }
  }
}

class _MockCommunity {
  _MockCommunity({
    required this.id,
    required this.title,
    required this.memberCount,
    required this.createdAt,
    required this.joinedAt,
    this.owned = false,
    this.status = CommunityStatus.open,
    this.lifecycleVersion = 1,
    Set<CommunityCapability> delegated = const {},
  }) : delegated = {...delegated};

  final String id;
  final String title;
  final int memberCount;
  final DateTime createdAt;
  final bool owned;
  DateTime joinedAt;
  CommunityStatus status;
  int lifecycleVersion;
  Set<CommunityCapability> delegated;
  bool viewerIsMember = true;

  /// What LOCKED closes (lifecycle.ts): new members, posting, starting live.
  static const _closedWhenLocked = {
    CommunityCapability.membersInvite,
    CommunityCapability.chatPost,
    CommunityCapability.liveStart,
  };

  Community view() {
    final held = owned
        ? {
            for (final c in CommunityCapability.values)
              if (c != CommunityCapability.unknown) c,
          }
        : delegated;
    return Community(
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
          for (final c in held)
            if (status == CommunityStatus.open ||
                !_closedWhenLocked.contains(c))
              c,
        },
        // Reading the chat and joining live stay open while LOCKED.
        participation: {
          for (final p in CommunityParticipation.values)
            if (p != CommunityParticipation.unknown) p,
        },
      ),
      origin: DataOrigin.mock,
    );
  }
}
