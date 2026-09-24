import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';

import 'community_test_support.dart';

/// The demo's communities keep the server's rules — so the screens built on
/// them behave the same against the real API — and the demo's messaging has
/// each of their chats.
void main() {
  late MockCommunityRepository repo;
  setUp(() => repo = MockCommunityRepository(latency: Duration.zero));

  Matcher refusedWith(String code) =>
      throwsA(isA<CommunityException>().having((e) => e.code, 'code', code));

  test('pages as the server does by default: 30 communities, 50 members', () {
    expect(repo.communityPageSize, 30);
    expect(repo.memberPageSize, 50);
  });

  test('lists the viewer’s communities, most recently joined first', () async {
    final page = await repo.communities();
    expect(page.items.map((c) => c.id), seededIds);
    expect(page.nextCursor, isNull);
    expect(page.items.every((c) => c.origin == DataOrigin.mock), isTrue);
  });

  test('walks the list by opaque cursors, each community once', () async {
    final small = MockCommunityRepository(
      latency: Duration.zero,
      communityPageSize: 2,
    );
    final seen = <String>[];
    String? cursor;
    var pages = 0;
    do {
      final page = await small.communities(cursor: cursor);
      seen.addAll(page.items.map((c) => c.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor != null);
    expect(seen, seededIds);
    expect(pages, 3);
  });

  test(
    'answers each seeded community as the server would for the viewer',
    () async {
      final open = await repo.community(MockCommunityRepository.openId);
      expect(open.me.standing, CommunityStanding.member);
      expect(open.canOpenChat, isTrue);
      expect(open.canViewMembers, isFalse);

      final owned = await repo.community(MockCommunityRepository.ownedId);
      expect(owned.me.standing, CommunityStanding.owner);
      expect(owned.me.capabilities, hasLength(7));

      final delegated = await repo.community(
        MockCommunityRepository.delegatedId,
      );
      expect(delegated.me.standing, CommunityStanding.member);
      expect(delegated.me.capabilities, {CommunityCapability.membersView});

      final locked = await repo.community(MockCommunityRepository.lockedId);
      expect(locked.isLocked, isTrue);
      expect(locked.canOpenChat, isTrue); // reading stays open while locked

      final large = await repo.community(MockCommunityRepository.largeId);
      expect(large.memberCount, 30000);
      expect(large.canViewMembers, isTrue);
    },
  );

  test('applies the lifecycle to what the owner may do', () async {
    const id = MockCommunityRepository.ownedId;
    final before = (await repo.community(id)).lifecycleVersion;
    expect(repo.changeStatus(id, CommunityStatus.locked), before + 1);
    // Locking again is no change: no new version.
    expect(repo.changeStatus(id, CommunityStatus.locked), before + 1);
    final owned = await repo.community(id);
    expect(owned.isLocked, isTrue);
    expect(owned.me.has(CommunityCapability.chatPost), isFalse);
    expect(owned.me.has(CommunityCapability.membersInvite), isFalse);
    expect(owned.me.has(CommunityCapability.lock), isTrue); // so it can unlock
    expect(owned.canOpenChat, isTrue);
  });

  test(
    'pages a 30,000-member roster by cursor without ever building it whole',
    () async {
      const id = MockCommunityRepository.largeId;
      final first = await repo.members(id);
      expect(first.items, hasLength(50));
      expect(repo.membersBuilt, 50);

      final second = await repo.members(id, cursor: first.nextCursor);
      expect(second.items, hasLength(50));
      expect(
        second.items
            .map((m) => m.userId)
            .toSet()
            .intersection(first.items.map((m) => m.userId).toSet()),
        isEmpty,
      );
      // Two pages asked for, two pages built: nothing ahead of the reader.
      expect(repo.membersBuilt, 100);

      // The whole walk still ends exactly at the count, each member once.
      final ids = <String>{
        ...first.items.map((m) => m.userId),
        ...second.items.map((m) => m.userId),
      };
      var cursor = second.nextCursor;
      var pages = 2;
      while (cursor != null) {
        final page = await repo.members(id, cursor: cursor);
        expect(page.items.length, lessThanOrEqualTo(50));
        ids.addAll(page.items.map((m) => m.userId));
        cursor = page.nextCursor;
        pages += 1;
      }
      expect(pages, 600);
      expect(ids, hasLength(30000));
      expect(repo.membersBuilt, 30000);
    },
  );

  test(
    'shows a roster row without an id or an email in place of a name',
    () async {
      final page = await repo.members(MockCommunityRepository.largeId);
      expect(page.items.any((m) => m.displayName == null), isTrue);
      expect(page.items.any((m) => !m.active), isTrue);
      for (final member in page.items) {
        final name = member.displayName;
        if (name == null) continue;
        expect(name.contains('@'), isFalse);
        expect(name.contains(member.userId), isFalse);
      }
    },
  );

  test('refuses what the server refuses', () async {
    await expectLater(
      repo.community('mock-community-nowhere'),
      refusedWith('communities.community_not_found'),
    );
    await expectLater(
      repo.members(MockCommunityRepository.openId),
      refusedWith('communities.capability_required'),
    );
    final page = await repo.members(MockCommunityRepository.delegatedId);
    await expectLater(
      repo.members(MockCommunityRepository.largeId, cursor: page.nextCursor),
      refusedWith('communities.cursor_invalid'),
    );
    await expectLater(
      repo.members(MockCommunityRepository.largeId, cursor: 'not-a-cursor'),
      refusedWith('communities.cursor_invalid'),
    );
  });

  test(
    'forgets a community the viewer is no longer in, and knows a rejoin',
    () async {
      const id = MockCommunityRepository.openId;
      repo.endMembership(id);
      await expectLater(
        repo.community(id),
        refusedWith('communities.community_not_found'),
      );
      expect(
        (await repo.communities()).items.map((c) => c.id),
        isNot(contains(id)),
      );
      repo.restoreMembership(id);
      expect((await repo.communities()).items.first.id, id);
    },
  );

  group('the demo’s messaging', () {
    late MockMessagingRepository messaging;
    setUp(() => messaging = MockMessagingRepository(latency: Duration.zero));

    test(
      'has the chat of every community whose chat the viewer may read',
      () async {
        final listed = (await messaging.conversations()).items;
        for (final community in (await repo.communities()).items) {
          if (!community.canOpenChat) continue;
          final chat = await messaging.conversationForCommunity(community.id);
          expect(chat.type, ConversationType.channel);
          expect(chat.communityId, community.id);
          expect(chat.title, community.title);
          expect(chat.memberCount, community.memberCount);
          expect(chat.origin, DataOrigin.mock);
          // Posting is what the community allows: its owner, while open.
          expect(chat.canPost, community.me.has(CommunityCapability.chatPost));
          expect(listed.map((c) => c.id), contains(chat.id));
        }
      },
    );

    test(
      'answers an unknown community as a conversation that is not there',
      () async {
        await expectLater(
          messaging.conversationForCommunity('mock-community-nowhere'),
          throwsA(
            isA<MessagingException>().having(
              (e) => e.code,
              'code',
              'messaging.conversation_not_found',
            ),
          ),
        );
      },
    );

    test('keeps posting closed to a reader of a community chat', () async {
      await expectLater(
        messaging.sendText(
          chatOf(MockCommunityRepository.openId),
          clientMessageId: 'community-key-1',
          body: 'x',
        ),
        throwsA(
          isA<MessagingException>().having(
            (e) => e.code,
            'code',
            'messaging.posting_not_allowed',
          ),
        ),
      );
    });
  });
}
