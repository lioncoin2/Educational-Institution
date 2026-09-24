import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/messaging.dart';

import 'community_test_support.dart';

/// The wire models read what the server sends — and survive what a newer
/// server may send: unknown values are dropped or `unknown`, never an
/// action; a missing list is empty, a missing boolean false; a list item
/// that cannot be identified is skipped, never fatal to its page.
void main() {
  group('a community', () {
    test('reads the server’s CommunityResponse', () {
      final community = Community.fromJson(
        communityJson(
          status: 'LOCKED',
          lifecycleVersion: 4,
          memberCount: 30000,
          standing: 'OWNER',
          capabilities: ['community.members.view', 'community.lock'],
        ),
      );
      expect(community.id, 'community-1');
      expect(community.title, 'مجتمع الخادم');
      expect(community.status, CommunityStatus.locked);
      expect(community.isLocked, isTrue);
      expect(community.lifecycleVersion, 4);
      expect(community.memberCount, 30000);
      expect(community.createdAt, DateTime.utc(2026, 9, 1, 8));
      expect(community.me.standing, CommunityStanding.owner);
      expect(community.me.joinedAt, DateTime.utc(2026, 9, 2, 8));
      expect(community.me.capabilities, {
        CommunityCapability.membersView,
        CommunityCapability.lock,
      });
      expect(community.me.participation, hasLength(4));
      expect(community.canOpenChat, isTrue);
      expect(community.canViewMembers, isTrue);
      expect(community.origin, DataOrigin.records);
    });

    test('ignores keys it does not know', () {
      final json = communityJson()
        ..['archivedAt'] = '2027-01-01T00:00:00.000Z'
        ..['roster'] = ['someone'];
      (json['me']! as Map)['membershipVersion'] = 12;
      final community = Community.fromJson(json);
      expect(community.id, 'community-1');
      expect(community.me.standing, CommunityStanding.member);
    });

    test(
      'drops capabilities and acts it does not know — they unlock nothing',
      () {
        final community = Community.fromJson(
          communityJson(
            capabilities: [
              'community.messages.moderate',
              'community.members.view',
              '',
            ],
            participation: ['community.teleport', 'community.view'],
          ),
        );
        expect(community.me.capabilities, {CommunityCapability.membersView});
        expect(community.me.participation, {CommunityParticipation.view});
        expect(community.me.has(CommunityCapability.unknown), isFalse);
        expect(community.me.takesPart(CommunityParticipation.unknown), isFalse);
        // No chat.read among what it knows: the chat is not offered.
        expect(community.canOpenChat, isFalse);
      },
    );

    test('keeps a status or standing it does not know as unknown', () {
      final community = Community.fromJson(
        communityJson(status: 'ARCHIVED', standing: 'CO_OWNER'),
      );
      expect(community.status, CommunityStatus.unknown);
      expect(community.isLocked, isFalse);
      expect(community.me.standing, CommunityStanding.unknown);
      expect(community.me.isOversight, isFalse);
    });

    test('reads a null standing as oversight, and only a null one', () {
      final overseen = Community.fromJson(communityJson(standing: null));
      expect(overseen.me.isOversight, isTrue);
      expect(overseen.me.joinedAt, isNull);

      final json = communityJson();
      (json['me']! as Map).remove('standing');
      expect(Community.fromJson(json).me.isOversight, isFalse);
      expect(Community.fromJson(json).me.standing, CommunityStanding.unknown);
    });

    test('treats missing lists as empty and a missing me as no rights', () {
      final json = communityJson();
      json['me'] = {'standing': 'MEMBER'};
      final bare = Community.fromJson(json);
      expect(bare.me.capabilities, isEmpty);
      expect(bare.me.participation, isEmpty);
      expect(bare.canOpenChat, isFalse);
      expect(bare.canViewMembers, isFalse);

      final noMe = Community.fromJson(communityJson()..remove('me'));
      expect(noMe.me.standing, CommunityStanding.unknown);
      expect(noMe.me.isOversight, isFalse);
      expect(noMe.canOpenChat, isFalse);
    });

    test('cannot be read without an id, a title or a creation date', () {
      for (final key in ['id', 'title', 'createdAt']) {
        expect(
          () => Community.fromJson(communityJson()..remove(key)),
          throwsFormatException,
          reason: key,
        );
      }
    });
  });

  group('pages', () {
    test('skip an item they cannot read, and keep the rest', () {
      final page = CommunityPage.fromJson({
        'items': [
          communityJson(id: 'good'),
          communityJson()..remove('id'),
          'not an object',
          communityJson(id: 'also-good')..['memberCount'] = 'many',
        ],
        'nextCursor': 'opaque',
      });
      expect(page.items.map((c) => c.id), ['good', 'also-good']);
      expect(page.items.last.memberCount, 0);
      expect(page.nextCursor, 'opaque');
    });

    test(
      'read a missing item list as empty and a missing cursor as the end',
      () {
        final page = CommunityMemberPage.fromJson({});
        expect(page.items, isEmpty);
        expect(page.nextCursor, isNull);
      },
    );

    test('read a roster row, a missing name and a missing flag', () {
      final page = CommunityMemberPage.fromJson({
        'items': [
          memberJson('u-1', displayName: 'مريم', active: false),
          memberJson('u-2', displayName: null)..remove('active'),
          memberJson('u-3')..remove('joinedAt'),
        ],
        'nextCursor': null,
      });
      expect(page.items.map((m) => m.userId), ['u-1', 'u-2']);
      expect(page.items.first.displayName, 'مريم');
      expect(page.items.first.active, isFalse);
      expect(page.items.last.displayName, isNull);
      expect(page.items.last.active, isFalse); // missing boolean → false
      expect(page.items.first.joinedAt, DateTime.utc(2026, 9, 3, 8));
    });
  });

  group('a refusal', () {
    test('tells gone, forbidden, sign-in and network apart', () {
      const gone = CommunityException('communities.community_not_found', '');
      const capability = CommunityException(
        'communities.capability_required',
        '',
      );
      const permission = CommunityException('identity.permission_denied', '');
      const signIn = CommunityException('identity.authentication_required', '');
      const network = CommunityException('network.unreachable', '');
      expect(gone.isGone, isTrue);
      expect(gone.isForbidden, isFalse);
      expect(capability.isForbidden, isTrue);
      expect(permission.isForbidden, isTrue);
      expect(signIn.needsSignIn, isTrue);
      expect(network.isNetwork, isTrue);
      expect(network.isGone || network.isForbidden, isFalse);
    });
  });

  group('a conversation that is a community’s chat', () {
    Map<String, Object?> conversationJson({Object? communityId}) => {
      'id': 'c-1',
      'type': 'CHANNEL',
      'communityId': communityId,
      'title': 'مجتمع الخادم',
      'counterpartUserId': null,
      'memberCount': 3,
      'myRole': 'MEMBER',
      'canPost': false,
      'canManageMembers': false,
      'lastSequence': 2,
      'lastReadSequence': 1,
      'unreadCount': 1,
      'lastMessage': null,
      'createdAt': '2026-09-01T08:00:00.000Z',
      'activityAt': '2026-09-01T09:00:00.000Z',
    };

    test('carries its community’s id; anything else means none', () {
      expect(
        Conversation.fromJson(conversationJson(communityId: 'community-1'))
            .communityId,
        'community-1',
      );
      for (final value in [null, '', 7]) {
        final c = Conversation.fromJson(conversationJson(communityId: value));
        expect(c.communityId, isNull, reason: '$value');
        expect(c.isCommunityChat, isFalse);
      }
      expect(
        Conversation.fromJson(conversationJson()..remove('communityId'))
            .communityId,
        isNull,
      );
    });

    test('keeps it through a new message and a read mark', () {
      final chat = Conversation.fromJson(
        conversationJson(communityId: 'community-1'),
      );
      final message = Message(
        id: 'm-3',
        conversationId: 'c-1',
        sequence: 3,
        senderId: 'u-9',
        type: MessageType.text,
        body: 'السلام عليكم',
        createdAt: DateTime.utc(2026, 9, 1, 10),
      );
      final after = chat.withMessage(message, fromViewer: false);
      expect(after.communityId, 'community-1');
      expect(after.withReadUpTo(3).communityId, 'community-1');
    });
  });
}
