import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';

const viewer = MockCommunityRepository.viewer;

/// The mock server, with a record of every request and switches for the
/// states the state layer must survive:
///
///   [failWith]          every read refused with this code while set
///   [holdList],         a read takes its answer (or its refusal) NOW and
///   [holdCommunity],    hands it over only when released — a read that was
///   [holdMembers],      answered before a change it arrives after, as a
///   [holdInvitations],  slow network delivers one
///   [holdGrants]
///   [failWritesWith]    every write refused with this code while set, and
///                       not done
///   [holdWrites]        a write is done NOW, its answer (or its refusal)
///                       handed over only when released
///
/// [writes] records each write as `'<method> <community> <target>'` — a
/// join as `'join'` alone: a token is recorded nowhere.
class ScriptedCommunities extends MockCommunityRepository {
  ScriptedCommunities({
    super.communityPageSize,
    super.memberPageSize,
    super.invitationPageSize,
    super.clock,
  }) : super(latency: Duration.zero);

  int listRequests = 0;
  final List<String> communityRequests = [];
  final List<String?> memberCursors = [];
  final List<String?> invitationCursors = [];
  final List<String> grantRequests = [];
  final List<String> writes = [];
  String? failWith;
  String? failWritesWith;
  Completer<void>? holdList;
  Completer<void>? holdCommunity;
  Completer<void>? holdMembers;
  Completer<void>? holdInvitations;
  Completer<void>? holdGrants;
  Completer<void>? holdWrites;

  @override
  Future<CommunityPage> communities({String? cursor}) async {
    listRequests += 1;
    _fail();
    final answer = await super.communities(cursor: cursor);
    await holdList?.future;
    return answer;
  }

  @override
  Future<Community> community(String communityId) async {
    communityRequests.add(communityId);
    _fail();
    try {
      return await super.community(communityId);
    } finally {
      await holdCommunity?.future;
    }
  }

  @override
  Future<CommunityMemberPage> members(
    String communityId, {
    String? cursor,
  }) async {
    memberCursors.add(cursor);
    _fail();
    try {
      return await super.members(communityId, cursor: cursor);
    } finally {
      await holdMembers?.future;
    }
  }

  @override
  Future<InvitationPage> invitations(
    String communityId, {
    String? cursor,
  }) async {
    invitationCursors.add(cursor);
    _fail();
    try {
      return await super.invitations(communityId, cursor: cursor);
    } finally {
      await holdInvitations?.future;
    }
  }

  @override
  Future<GrantPage> grants(
    String communityId, {
    required String userId,
    String? cursor,
  }) async {
    grantRequests.add(userId);
    _fail();
    try {
      return await super.grants(communityId, userId: userId, cursor: cursor);
    } finally {
      await holdGrants?.future;
    }
  }

  @override
  Future<CreatedInvitation> createInvitation(String communityId) => _write(
    'createInvitation $communityId',
    () => super.createInvitation(communityId),
  );

  @override
  Future<CommunityInvitation> revokeInvitation(
    String communityId,
    String invitationId,
  ) => _write(
    'revokeInvitation $communityId $invitationId',
    () => super.revokeInvitation(communityId, invitationId),
  );

  @override
  Future<Community> join(String token) =>
      _write('join', () => super.join(token));

  @override
  Future<void> removeMember(String communityId, String userId) => _write(
    'removeMember $communityId $userId',
    () => super.removeMember(communityId, userId),
  );

  @override
  Future<void> leave(String communityId) =>
      _write('leave $communityId', () => super.leave(communityId));

  @override
  Future<Community> lock(String communityId) =>
      _write('lock $communityId', () => super.lock(communityId));

  @override
  Future<Community> unlock(String communityId) =>
      _write('unlock $communityId', () => super.unlock(communityId));

  @override
  Future<GrantChange> grant(
    String communityId, {
    required String userId,
    required Set<CommunityCapability> capabilities,
  }) => _write(
    'grant $communityId $userId',
    () => super.grant(communityId, userId: userId, capabilities: capabilities),
  );

  @override
  Future<void> revokeGrant(String communityId, String grantId) => _write(
    'revokeGrant $communityId $grantId',
    () => super.revokeGrant(communityId, grantId),
  );

  @override
  Future<Community> transferOwnership(String communityId, String userId) =>
      _write(
        'transferOwnership $communityId $userId',
        () => super.transferOwnership(communityId, userId),
      );

  /// Ends the viewer's membership everywhere: an empty list.
  void leaveAll() {
    for (final id in seededIds) {
      endMembership(id);
    }
  }

  void _fail() {
    final code = failWith;
    if (code != null) throw CommunityException(code, code);
  }

  Future<T> _write<T>(String record, Future<T> Function() work) async {
    writes.add(record);
    final code = failWritesWith;
    if (code != null) throw CommunityException(code, code);
    try {
      return await work();
    } finally {
      await holdWrites?.future;
    }
  }
}

const seededIds = [
  MockCommunityRepository.openId,
  MockCommunityRepository.ownedId,
  MockCommunityRepository.delegatedId,
  MockCommunityRepository.lockedId,
  MockCommunityRepository.largeId,
];

/// The mock messaging server, with community chats that can be taken away
/// (as the server stops listing a chat once its community is left) and
/// switches for how the community route answers. With a
/// [conversationPageSize] the list comes in pages of that size; [holdList]
/// and [holdConversation] hand a read's answer over only when released, as
/// [ScriptedCommunities]' holds do.
class ScriptedMessaging extends MockMessagingRepository {
  ScriptedMessaging({this.conversationPageSize})
    : super(latency: Duration.zero);

  final int? conversationPageSize;
  int listRequests = 0;
  final List<String> conversationRequests = [];
  Completer<void>? holdList;
  Completer<void>? holdConversation;

  /// Communities whose chat the server no longer shows the viewer.
  final Set<String> leftCommunities = {};

  /// Per conversation id: whether the server now lets the viewer post.
  final Map<String, bool> canPostOverride = {};

  /// The community route's refusal, while set.
  String? chatLookupFailure;

  /// Thrown as is by the community route while set: an answer that could
  /// not be read as a conversation.
  Object? chatLookupGarbled;

  @override
  Future<ConversationPage> conversations({String? cursor}) async {
    listRequests += 1;
    final page = await super.conversations(cursor: cursor);
    final shown = [
      for (final c in page.items)
        if (!leftCommunities.contains(c.communityId)) _adjusted(c),
    ];
    final size = conversationPageSize;
    final ConversationPage answer;
    if (size == null) {
      answer = ConversationPage(items: shown, nextCursor: page.nextCursor);
    } else {
      // An offset cursor: a list that changed meanwhile shifts under it.
      final start = min(cursor == null ? 0 : int.parse(cursor), shown.length);
      final end = min(start + size, shown.length);
      answer = ConversationPage(
        items: shown.sublist(start, end),
        nextCursor: end < shown.length ? '$end' : null,
      );
    }
    await holdList?.future;
    return answer;
  }

  @override
  Future<Conversation> conversation(String conversationId) async {
    conversationRequests.add(conversationId);
    try {
      final c = await super.conversation(conversationId);
      if (leftCommunities.contains(c.communityId)) {
        throw const MessagingException(
          'messaging.conversation_not_found',
          'No such conversation.',
        );
      }
      return _adjusted(c);
    } finally {
      await holdConversation?.future;
    }
  }

  @override
  Future<Conversation> conversationForCommunity(String communityId) async {
    final failure = chatLookupFailure;
    if (failure != null) throw MessagingException(failure, failure);
    final garbled = chatLookupGarbled;
    if (garbled != null) throw garbled;
    if (leftCommunities.contains(communityId)) {
      throw const MessagingException(
        'messaging.conversation_not_found',
        'No such conversation.',
      );
    }
    return _adjusted(await super.conversationForCommunity(communityId));
  }

  Conversation _adjusted(Conversation c) {
    final canPost = canPostOverride[c.id];
    return canPost == null ? c : withCanPost(c, canPost);
  }
}

Conversation withCanPost(Conversation c, bool canPost) => Conversation(
  id: c.id,
  type: c.type,
  title: c.title,
  counterpartUserId: c.counterpartUserId,
  memberCount: c.memberCount,
  myRole: c.myRole,
  canPost: canPost,
  canManageMembers: c.canManageMembers,
  lastSequence: c.lastSequence,
  lastReadSequence: c.lastReadSequence,
  unreadCount: c.unreadCount,
  lastMessage: c.lastMessage,
  createdAt: c.createdAt,
  activityAt: c.activityAt,
  communityId: c.communityId,
  origin: c.origin,
);

String chatOf(String communityId) => '$communityId-chat';

// ── Frames, as the server builds them ───────────────────────────────────────

var _sequence = 0;
final _at = DateTime.utc(2026, 9, 24, 10);

CommunityMemberAddedEvent added(String communityId, {String userId = viewer}) =>
    CommunityMemberAddedEvent(
      eventId: 'community.member.added:$communityId:$userId:${_sequence++}',
      occurredAt: _at,
      communityId: communityId,
      userId: userId,
    );

CommunityMemberRemovedEvent removed(
  String communityId, {
  String userId = viewer,
  CommunityRemovalReason reason = CommunityRemovalReason.removed,
}) => CommunityMemberRemovedEvent(
  eventId: 'community.member.removed:$communityId:$userId:${_sequence++}',
  occurredAt: _at,
  communityId: communityId,
  userId: userId,
  reason: reason,
);

CommunityLockedEvent locked(String communityId, int lifecycleVersion) =>
    CommunityLockedEvent(
      eventId: 'community.locked:$communityId:$lifecycleVersion',
      occurredAt: _at,
      communityId: communityId,
      lifecycleVersion: lifecycleVersion,
    );

CommunityUnlockedEvent unlocked(String communityId, int lifecycleVersion) =>
    CommunityUnlockedEvent(
      eventId: 'community.unlocked:$communityId:$lifecycleVersion',
      occurredAt: _at,
      communityId: communityId,
      lifecycleVersion: lifecycleVersion,
    );

CommunityAccessChangedEvent accessChanged(String communityId) =>
    CommunityAccessChangedEvent(
      eventId: 'community.access.changed:$communityId:$viewer:${_sequence++}',
      occurredAt: _at,
      communityId: communityId,
    );

// ── The HTTP side ───────────────────────────────────────────────────────────

http.Response jsonResponse(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

http.Response refusal(
  int status,
  String code, {
  Map<String, Object?>? details,
}) => jsonResponse(status, {
  'error': {'kind': 'x', 'code': code, 'message': code, 'details': ?details},
  'requestId': 'req-1',
});

/// A `CommunityResponse` exactly as backend/src/modules/communities/api/
/// responses.ts writes it.
Map<String, Object?> communityJson({
  String id = 'community-1',
  String title = 'مجتمع الخادم',
  String status = 'OPEN',
  int lifecycleVersion = 1,
  int memberCount = 3,
  String? standing = 'MEMBER',
  List<String> capabilities = const [],
  List<String> participation = const [
    'community.view',
    'community.chat.read',
    'community.live.join',
    'community.live.raise_hand',
  ],
  List<String> operations = const [],
}) => {
  'id': id,
  'title': title,
  'status': status,
  'lifecycleVersion': lifecycleVersion,
  'memberCount': memberCount,
  'createdAt': '2026-09-01T08:00:00.000Z',
  'me': {
    'standing': standing,
    'joinedAt': standing == null ? null : '2026-09-02T08:00:00.000Z',
    'capabilities': capabilities,
    'participation': participation,
    'operations': operations,
  },
};

/// An `InvitationResponse` — never a token: the server has none to send.
Map<String, Object?> invitationJson(
  String id, {
  String createdBy = 'user-1',
  String state = 'ACTIVE',
  int? maxUses,
  int uses = 0,
  String? revokedAt,
}) => {
  'id': id,
  'createdBy': createdBy,
  'createdAt': '2026-09-20T08:00:00.000Z',
  'expiresAt': '2026-09-27T08:00:00.000Z',
  'maxUses': maxUses,
  'uses': uses,
  'state': state,
  'revokedAt': revokedAt,
};

/// A `GrantResponse`.
Map<String, Object?> grantJson(
  String grantId, {
  String userId = 'user-2',
  String capability = 'community.members.view',
  bool dormant = false,
}) => {
  'grantId': grantId,
  'userId': userId,
  'capability': capability,
  'grantedAt': '2026-09-21T08:00:00.000Z',
  'grantedBy': 'user-1',
  'dormant': dormant,
};

/// A `MemberResponse` row — exactly these four keys on the server.
Map<String, Object?> memberJson(
  String userId, {
  String? displayName = 'عضو الخادم',
  bool active = true,
}) => {
  'userId': userId,
  'displayName': displayName,
  'active': active,
  'joinedAt': '2026-09-03T08:00:00.000Z',
};

const signedInUser = {
  'id': 'user-2',
  'displayName': 'طالبة الخادم',
  'status': 'ACTIVE',
  'roles': ['STUDENT'],
  'permissions': ['communities.read', 'messaging.read'],
};

/// A scripted backend: records every request, answers by method + path;
/// anything unscripted is a 404 the app has never heard of.
class CommunityServer {
  CommunityServer(this.routes);

  final Map<String, http.Response Function(http.Request request)> routes;
  final List<http.Request> requests = [];

  late final http.Client client = MockClient((request) async {
    requests.add(request);
    final handler = routes['${request.method} ${request.url.path}'];
    if (handler == null) return refusal(404, 'not_found');
    return handler(request);
  });

  List<String> get calls => [
    for (final r in requests) '${r.method} ${r.url.path}',
  ];
}
