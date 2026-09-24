import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';

const viewer = MockCommunityRepository.viewer;

/// The mock server, with a record of every read and switches for the
/// states the state layer must survive:
///
///   [failWith]     every read refused with this code while set
///   [holdList] /   a read takes its answer NOW and hands it over only when
///   [holdCommunity] released — a read that was answered before a change it
///                  arrives after, as a slow network delivers one
class ScriptedCommunities extends MockCommunityRepository {
  ScriptedCommunities({super.communityPageSize, super.memberPageSize})
    : super(latency: Duration.zero);

  int listRequests = 0;
  final List<String> communityRequests = [];
  final List<String?> memberCursors = [];
  String? failWith;
  Completer<void>? holdList;
  Completer<void>? holdCommunity;

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
    final answer = await super.community(communityId);
    await holdCommunity?.future;
    return answer;
  }

  @override
  Future<CommunityMemberPage> members(
    String communityId, {
    String? cursor,
  }) async {
    memberCursors.add(cursor);
    _fail();
    return super.members(communityId, cursor: cursor);
  }

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
/// switches for how the community route answers.
class ScriptedMessaging extends MockMessagingRepository {
  ScriptedMessaging() : super(latency: Duration.zero);

  int listRequests = 0;
  final List<String> conversationRequests = [];

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
    return ConversationPage(
      items: [
        for (final c in page.items)
          if (!leftCommunities.contains(c.communityId)) _adjusted(c),
      ],
      nextCursor: page.nextCursor,
    );
  }

  @override
  Future<Conversation> conversation(String conversationId) async {
    conversationRequests.add(conversationId);
    final c = await super.conversation(conversationId);
    if (leftCommunities.contains(c.communityId)) {
      throw const MessagingException(
        'messaging.conversation_not_found',
        'No such conversation.',
      );
    }
    return _adjusted(c);
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

http.Response refusal(int status, String code) => jsonResponse(status, {
  'error': {'kind': 'x', 'code': code, 'message': code},
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
  },
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
