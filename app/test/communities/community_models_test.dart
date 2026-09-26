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

  group('what the viewer may do beyond the acts', () {
    test('reads the server’s operations, in any order', () {
      final me = Community.fromJson(
        communityJson(
          standing: 'OWNER',
          operations: [
            'community.ownership.transfer',
            'community.invitations.manage',
            'community.grants.manage',
          ],
        ),
      ).me;
      expect(me.operations, {
        CommunityOperation.invitationsManage,
        CommunityOperation.grantsManage,
        CommunityOperation.ownershipTransfer,
      });
      expect(me.allows(CommunityOperation.grantsManage), isTrue);
      expect(me.allows(CommunityOperation.leave), isFalse);
    });

    test('drops an operation it does not know — it unlocks nothing', () {
      final me = Community.fromJson(
        communityJson(
          operations: ['community.archive', 'community.leave', '', 'unknown'],
        ),
      ).me;
      expect(me.operations, {CommunityOperation.leave});
      expect(me.allows(CommunityOperation.unknown), isFalse);
      for (final wire in ['community.archive', 'unknown', null, 7]) {
        expect(CommunityOperation.fromWire(wire), CommunityOperation.unknown);
      }
    });

    test('reads none from an older server that sends none', () {
      final json = communityJson();
      (json['me']! as Map).remove('operations');
      expect(Community.fromJson(json).me.operations, isEmpty);
      (json['me']! as Map)['operations'] = 'community.leave';
      expect(Community.fromJson(json).me.operations, isEmpty);
      expect(const CommunityMe().operations, isEmpty);
    });

    test('knows the wire value of each', () {
      expect(
        [
          for (final o in CommunityOperation.values)
            if (o != CommunityOperation.unknown) o.wire,
        ],
        [
          'community.invitations.manage',
          'community.grants.manage',
          'community.ownership.transfer',
          'community.leave',
        ],
      );
    });
  });

  group('an invitation link', () {
    test('reads the server’s InvitationResponse', () {
      final link = CommunityInvitation.fromJson(
        invitationJson(
          'inv-1',
          createdBy: 'user-9',
          state: 'REVOKED',
          maxUses: 5,
          uses: 2,
          revokedAt: '2026-09-22T08:00:00.000Z',
        ),
      );
      expect(link.id, 'inv-1');
      expect(link.createdBy, 'user-9');
      expect(link.createdAt, DateTime.utc(2026, 9, 20, 8));
      expect(link.expiresAt, DateTime.utc(2026, 9, 27, 8));
      expect(link.maxUses, 5);
      expect(link.uses, 2);
      expect(link.state, InvitationState.revoked);
      expect(link.revokedAt, DateTime.utc(2026, 9, 22, 8));
      expect(link.origin, DataOrigin.records);
    });

    test('keeps a state it does not know as unknown, and each it does', () {
      for (final (wire, state) in [
        ('ACTIVE', InvitationState.active),
        ('EXPIRED', InvitationState.expired),
        ('EXHAUSTED', InvitationState.exhausted),
        ('REVOKED', InvitationState.revoked),
        ('SUSPENDED', InvitationState.unknown),
        (null, InvitationState.unknown),
      ]) {
        final json = invitationJson('inv-1')..['state'] = wire;
        expect(CommunityInvitation.fromJson(json).state, state, reason: wire);
      }
    });

    test('reads no limit, and no maker, where none is readable', () {
      final json = invitationJson('inv-1', maxUses: 3)
        ..['maxUses'] = 'three'
        ..['uses'] = null
        ..remove('createdBy')
        ..['revokedAt'] = 'yesterday'
        ..['token'] = 'never-sent'
        ..['tokenHash'] = 'never-sent';
      final link = CommunityInvitation.fromJson(json);
      expect(link.maxUses, isNull);
      expect(link.uses, 0);
      expect(link.createdBy, isNull);
      expect(link.revokedAt, isNull);
    });

    test('cannot be read without an id, or its dates', () {
      for (final key in ['id', 'createdAt', 'expiresAt']) {
        expect(
          () => CommunityInvitation.fromJson(
            invitationJson('inv-1')..remove(key),
          ),
          throwsFormatException,
          reason: key,
        );
      }
    });

    test('pages newest first, skipping what it cannot read', () {
      final page = InvitationPage.fromJson({
        'items': [
          invitationJson('inv-2'),
          invitationJson('inv-1')..remove('expiresAt'),
          42,
          invitationJson('inv-0', state: 'EXPIRED'),
        ],
        'nextCursor': 'more',
      }, origin: DataOrigin.mock);
      expect(page.items.map((i) => i.id), ['inv-2', 'inv-0']);
      expect(page.items.every((i) => i.origin == DataOrigin.mock), isTrue);
      expect(page.nextCursor, 'more');
      expect(InvitationPage.fromJson({}).items, isEmpty);
    });

    test('is made with its token — the one answer that carries it', () {
      final created = CreatedInvitation.fromJson({
        'invitation': invitationJson('inv-3'),
        'token': 'A' * 43,
      });
      expect(created.invitation.id, 'inv-3');
      expect(created.token, 'A' * 43);
      for (final broken in [
        {'invitation': invitationJson('inv-3')},
        {'invitation': invitationJson('inv-3'), 'token': ''},
        {'invitation': invitationJson('inv-3'), 'token': 43},
        {'token': 'A' * 43},
        {'invitation': 'inv-3', 'token': 'A' * 43},
        {
          'invitation': invitationJson('inv-3')..remove('id'),
          'token': 'A' * 43,
        },
      ]) {
        expect(
          () => CreatedInvitation.fromJson(broken),
          throwsA(
            isA<FormatException>().having(
              (e) => e.message,
              'message',
              isNot(contains('A' * 43)),
            ),
          ),
          reason: '$broken',
        );
      }
    });

    test('has a token’s shape only as the server issues one', () {
      expect(isInvitationTokenShaped('aZ09_-' * 7 + 'x'), isTrue);
      for (final token in [
        '',
        'A' * 42,
        'A' * 44,
        '${'A' * 42}=',
        '${'A' * 42}/',
        '${'A' * 42}+',
        '${'A' * 42} ',
        '${'A' * 41}أb',
      ]) {
        expect(isInvitationTokenShaped(token), isFalse, reason: token);
      }
    });
  });

  group('grants', () {
    test('read the server’s GrantResponse', () {
      final grant = CommunityGrant.fromJson(
        grantJson('g-1', capability: 'community.lock', dormant: true),
      );
      expect(grant.grantId, 'g-1');
      expect(grant.userId, 'user-2');
      expect(grant.capability, CommunityCapability.lock);
      expect(grant.grantedAt, DateTime.utc(2026, 9, 21, 8));
      expect(grant.grantedBy, 'user-1');
      expect(grant.dormant, isTrue);
    });

    test('keep one of a capability they do not know, as unknown', () {
      final page = GrantPage.fromJson({
        'items': [
          grantJson('g-1', capability: 'community.teleport'),
          grantJson('g-2')..remove('dormant'),
          grantJson('g-3')..remove('grantId'),
          grantJson('g-4')..remove('userId'),
          grantJson('g-5')..['grantedAt'] = 'then',
        ],
        'nextCursor': null,
      });
      expect(page.items.map((g) => g.grantId), ['g-1', 'g-2']);
      expect(page.items.first.capability, CommunityCapability.unknown);
      expect(page.items.last.dormant, isFalse); // missing boolean → false
      expect(page.nextCursor, isNull);
    });

    test('say what a grant request created and what was already held', () {
      final change = GrantChange.fromJson({
        'created': [grantJson('g-1', capability: 'community.members.view')],
        'unchanged': [
          grantJson('g-0', capability: 'community.lock'),
          {'grantId': 'g-x'},
        ],
      });
      expect(change.created.single.capability, CommunityCapability.membersView);
      expect(change.unchanged.single.grantId, 'g-0');
      final nothing = GrantChange.fromJson({});
      expect(nothing.created, isEmpty);
      expect(nothing.unchanged, isEmpty);
    });
  });

  group('a refusal', () {
    test('carries the server’s details, and sorts itself neutrally', () {
      const limited = CommunityException(
        'communities.too_many_attempts',
        '',
        details: {'retryAfterSeconds': 42},
      );
      expect(limited.isRateLimited, isTrue);
      expect(limited.retryAfter, const Duration(seconds: 42));
      expect(limited.details, {'retryAfterSeconds': 42});

      for (final code in [
        'communities.too_many_invitations',
        'communities.too_many_grants',
      ]) {
        expect(CommunityException(code, '').isRateLimited, isTrue);
        expect(CommunityException(code, '').retryAfter, isNull);
      }
      expect(
        const CommunityException(
          'communities.too_many_attempts',
          '',
          details: {'retryAfterSeconds': 'soon'},
        ).retryAfter,
        isNull,
      );
      expect(
        const CommunityException(
          'communities.too_many_attempts',
          '',
          details: {'retryAfterSeconds': 1.2},
        ).retryAfter,
        const Duration(seconds: 2),
      );

      expect(
        const CommunityException('communities.conflict', '').isConflict,
        isTrue,
      );
      expect(
        const CommunityException('communities.owner_conflict', '').isConflict,
        isTrue,
      );
      expect(
        const CommunityException('communities.community_locked', '').isLocked,
        isTrue,
      );
      expect(const CommunityException('unavailable', '').isUnavailable, isTrue);

      const plain = CommunityException('communities.invitation_invalid', '');
      expect(plain.details, isEmpty);
      expect(
        plain.isRateLimited ||
            plain.isConflict ||
            plain.isLocked ||
            plain.isUnavailable ||
            plain.isGone ||
            plain.isForbidden,
        isFalse,
      );
    });

    test('never prints its details', () {
      const refused = CommunityException(
        'communities.members_not_eligible',
        'Refused.',
        details: {
          'userIds': ['user-secret'],
        },
      );
      expect('$refused', isNot(contains('user-secret')));
      expect('$refused', contains('communities.members_not_eligible'));
    });

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
