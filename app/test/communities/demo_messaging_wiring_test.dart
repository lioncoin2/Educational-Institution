import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/http/http_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// The demo's two mocks tell one story, as the server's modules do: a
/// community's chat is read, and posted in, as that community's `me` says
/// now — joined, left, locked or handed over. Only the composition root
/// (app_providers.dart) wires them; no feature knows.
void main() {
  const owned = MockCommunityRepository.ownedId;
  const invited = MockCommunityRepository.invitedId;
  const heir = '${MockCommunityRepository.founder}-2';
  final ownedChat = chatOf(owned);
  final dawnChat = chatOf(invited);

  Matcher refusedWith(String code) =>
      throwsA(isA<MessagingException>().having((e) => e.code, 'code', code));

  Future<List<String>> listed(MessagingRepository messaging) async => [
    for (final c in (await messaging.conversations()).items) c.id,
  ];

  group('the demo’s messaging on its own', () {
    test('has its chats as seeded: none of a community the viewer starts '
        'outside, posting in the one it owns', () async {
      final messaging = MockMessagingRepository(latency: Duration.zero);
      expect(await listed(messaging), contains(ownedChat));
      expect(await listed(messaging), isNot(contains(dawnChat)));
      await expectLater(
        messaging.conversationForCommunity(invited),
        refusedWith('messaging.conversation_not_found'),
      );
      await expectLater(
        messaging.conversation(dawnChat),
        refusedWith('messaging.conversation_not_found'),
      );
      expect((await messaging.conversation(ownedChat)).canPost, isTrue);
      expect(
        (await messaging.conversation(chatOf(MockCommunityRepository.openId)))
            .canPost,
        isFalse,
      );
    });

    test('answers a community’s chat by what it is told', () async {
      var reads = false;
      var posts = false;
      final messaging = MockMessagingRepository(
        latency: Duration.zero,
        mayReadIn: (id) => id != invited || reads,
        mayPostIn: (_) => posts,
      );
      expect(await listed(messaging), isNot(contains(dawnChat)));
      for (final attempt in <Future<Object?> Function()>[
        () => messaging.conversation(dawnChat),
        () => messaging.messages(dawnChat),
        () => messaging.markRead(dawnChat, 1),
        () => messaging.sendText(dawnChat, clientMessageId: 'k-0', body: 'x'),
      ]) {
        await expectLater(
          attempt(),
          refusedWith('messaging.conversation_not_found'),
        );
      }
      // Someone else still posts where the viewer does not read.
      messaging.receive(dawnChat, senderId: 'mock-teacher', body: 'x');

      reads = true;
      expect(await listed(messaging), contains(dawnChat));
      final chat = await messaging.conversationForCommunity(invited);
      expect(chat.title, 'مجتمع حلقة الفجر');
      expect(chat.communityId, invited);
      expect(chat.canPost, isFalse);
      expect((await messaging.messages(dawnChat)).items, hasLength(3));

      // Posting as the community says — the owner's own chat included.
      expect((await messaging.conversation(ownedChat)).canPost, isFalse);
      await expectLater(
        messaging.sendText(ownedChat, clientMessageId: 'k-1', body: 'x'),
        refusedWith('messaging.posting_not_allowed'),
      );
      posts = true;
      expect((await messaging.conversation(dawnChat)).canPost, isTrue);
      final sent = await messaging.sendText(
        dawnChat,
        clientMessageId: 'k-2',
        body: 'السلام عليكم',
      );
      expect(sent.body, 'السلام عليكم');
      // Chats that are no community's are not asked.
      expect((await messaging.conversation('mock-direct')).canPost, isTrue);
    });
  });

  group('the composition root', () {
    late MockCommunityRepository communities;
    late ProviderContainer container;

    MessagingRepository messaging() =>
        container.read(messagingRepositoryProvider);

    setUp(() {
      communities = MockCommunityRepository(latency: Duration.zero);
      container = ProviderContainer(
        overrides: [communityRepositoryProvider.overrideWithValue(communities)],
      );
      addTearDown(container.dispose);
    });

    test('opens the chat of a community joined by link, and closes it once '
        'left', () async {
      expect(await listed(messaging()), isNot(contains(dawnChat)));
      await communities.join(MockCommunityRepository.demoActiveToken);

      final chat = await messaging().conversationForCommunity(invited);
      expect(chat.id, dawnChat);
      expect(chat.canPost, isFalse); // a member reads; posting is granted
      expect(await listed(messaging()), contains(dawnChat));

      await communities.leave(invited);
      await expectLater(
        messaging().conversationForCommunity(invited),
        refusedWith('messaging.conversation_not_found'),
      );
      expect(await listed(messaging()), isNot(contains(dawnChat)));
    });

    test('lets the viewer post as the community’s me says: locked, unlocked, '
        'handed over', () async {
      Future<bool> canPost() async =>
          (await messaging().conversation(ownedChat)).canPost;

      expect(await canPost(), isTrue);
      await messaging().sendText(ownedChat, clientMessageId: 'k-1', body: 'x');

      await communities.lock(owned);
      expect(await canPost(), isFalse);
      await communities.unlock(owned);
      expect(await canPost(), isTrue);

      await communities.transferOwnership(owned, heir);
      expect(await canPost(), isFalse);
      await expectLater(
        messaging().sendText(ownedChat, clientMessageId: 'k-2', body: 'x'),
        refusedWith('messaging.posting_not_allowed'),
      );
    });

    test('leaves the chats as seeded beside a community server that is not '
        'the mock', () async {
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.org/'),
        httpClient: MockClient((_) async => http.Response('', 500)),
        tokenStore: InMemoryTokenStore(),
      );
      final beside = ProviderContainer(
        overrides: [
          communityRepositoryProvider.overrideWithValue(
            HttpCommunityRepository(api),
          ),
        ],
      );
      addTearDown(beside.dispose);
      final seeded = beside.read(messagingRepositoryProvider);
      expect(seeded, isA<MockMessagingRepository>());
      expect(await listed(seeded), isNot(contains(dawnChat)));
      expect((await seeded.conversation(ownedChat)).canPost, isTrue);
    });
  });

  group('in the demo app', () {
    late MockCommunityRepository communities;
    late ProviderContainer container;

    String location() => container
        .read(routerProvider)
        .routerDelegate
        .currentConfiguration
        .last
        .matchedLocation;

    Future<void> go(WidgetTester tester, String path) async {
      container.read(routerProvider).go(path);
      await tester.pumpAndSettle();
    }

    Future<void> start(WidgetTester tester) async {
      tester.view.physicalSize = const Size(390, 1400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      communities = MockCommunityRepository(latency: Duration.zero);
      // Only the communities are stood in for; messaging is the app's own
      // wiring.
      container = ProviderContainer(
        overrides: [communityRepositoryProvider.overrideWithValue(communities)],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const QuranInstitutionApp(),
        ),
      );
      await tester.pump(const Duration(seconds: 3)); // the splash timer
      await tester.pumpAndSettle();
    }

    testWidgets('opens the chat of a community joined by link', (tester) async {
      await start(tester);
      await go(tester, '/communities/$invited');
      expect(find.text(CommunityCopy.gone), findsOneWidget);

      await communities.join(MockCommunityRepository.demoActiveToken);
      await go(tester, '/communities');
      await go(tester, '/communities/$invited');
      await tester.tap(find.text(CommunityCopy.openChat));
      await tester.pumpAndSettle();
      expect(location(), '/messages/$dawnChat');
      expect(
        find.text('نلتقي بعد صلاة الفجر لتلاوة الورد اليومي.'),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsNothing);
      expect(find.text(MessagingCopy.cannotPostHere), findsOneWidget);
    });

    testWidgets('closes the former owner’s composer once the community is '
        'handed over', (tester) async {
      await start(tester);
      await go(tester, '/communities/$owned');
      await tester.tap(find.text(CommunityCopy.openChat));
      await tester.pumpAndSettle();
      expect(location(), '/messages/$ownedChat');
      expect(find.byType(TextField), findsOneWidget);

      await communities.transferOwnership(owned, heir);
      await go(tester, '/communities/$owned');
      await tester.tap(find.text(CommunityCopy.openChat));
      await tester.pumpAndSettle();
      expect(location(), '/messages/$ownedChat');
      expect(find.byType(TextField), findsNothing);
      expect(find.text(MessagingCopy.cannotPostHere), findsOneWidget);
    });
  });
}
