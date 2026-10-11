import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/http/http_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';
import 'package:quran_institution_app/features/messaging/state/direct_message_starter.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// Direct messaging between students (Q6, owner GROUP A ruling). The server is
/// the boundary: a student reaches another student and no one else, and the
/// app discovers a peer only where it already sees them — a shared chat, never
/// a directory. The repository contract, the mock's matching semantics, the
/// starter, and the chat entry point.
void main() {
  http.Response json(int status, Object body) => http.Response(
    jsonEncode(body),
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );

  Map<String, Object?> directJson(String id, String counterpart) => {
    'id': id,
    'type': 'DIRECT',
    'title': 'زميل',
    'counterpartUserId': counterpart,
    'memberCount': 2,
    'myRole': 'MEMBER',
    'canPost': true,
    'canManageMembers': false,
    'lastSequence': 0,
    'lastReadSequence': 0,
    'unreadCount': 0,
    'lastMessage': null,
    'createdAt': '2026-09-01T08:00:00.000Z',
    'activityAt': '2026-09-01T08:00:00.000Z',
    'communityId': null,
  };

  Future<HttpMessagingRepository> httpRepo(http.Client client) async {
    final store = InMemoryTokenStore();
    await store.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
    return HttpMessagingRepository(
      ApiClient(
        baseUri: Uri.parse('https://api.test/'),
        httpClient: client,
        tokenStore: store,
      ),
      _StubAuth(),
    );
  }

  group('HttpMessagingRepository.startDirect', () {
    test('posts {userId} to the direct route and returns the conversation', () async {
      http.Request? seen;
      final repo = await httpRepo(
        MockClient((request) async {
          seen = request;
          return json(201, directJson('c-dm', 'peer-1'));
        }),
      );

      final conversation = await repo.startDirect('peer-1');

      expect(seen!.method, 'POST');
      expect(seen!.url.path, '/messaging/conversations/direct');
      expect(jsonDecode(seen!.body), {'userId': 'peer-1'});
      expect(conversation.type, ConversationType.direct);
      expect(conversation.counterpartUserId, 'peer-1');
    });

    test('a refused counterpart surfaces the server code', () async {
      final repo = await httpRepo(
        MockClient(
          (_) async => json(422, {
            'error': {
              'kind': 'validation',
              'code': 'messaging.participant_not_eligible',
              'message': 'no',
            },
          }),
        ),
      );

      await expectLater(
        repo.startDirect('a-teacher'),
        throwsA(
          isA<MessagingException>().having(
            (e) => e.code,
            'code',
            'messaging.participant_not_eligible',
          ),
        ),
      );
    });
  });

  group('MockMessagingRepository.startDirect (same semantics as the server)', () {
    late MockMessagingRepository repo;
    setUp(() => repo = MockMessagingRepository(latency: Duration.zero));

    test('starts one with a peer, and returns the same one next time', () async {
      final first = await repo.startDirect('mock-peer-1');
      expect(first.type, ConversationType.direct);
      expect(first.counterpartUserId, 'mock-peer-1');
      expect(first.title, 'أحمد');

      final again = await repo.startDirect('mock-peer-1');
      expect(again.id, first.id); // canonical: one conversation per pair
    });

    test('starts one with an eligible teacher too (Q6)', () async {
      final dm = await repo.startDirect('mock-teacher');
      expect(dm.type, ConversationType.direct);
      expect(dm.counterpartUserId, 'mock-teacher');
      expect(dm.title, 'الأستاذ عبدالله');
    });

    test('refuses an administrator and an unknown id alike — no probing', () async {
      for (final id in ['mock-admin', 'nobody']) {
        await expectLater(
          repo.startDirect(id),
          throwsA(
            isA<MessagingException>().having(
              (e) => e.code,
              'code',
              'messaging.participant_not_eligible',
            ),
          ),
        );
      }
    });

    test('refuses oneself', () async {
      await expectLater(
        repo.startDirect(MockMessagingRepository.viewer),
        throwsA(
          isA<MessagingException>().having(
            (e) => e.code,
            'code',
            'messaging.direct_with_self',
          ),
        ),
      );
    });
  });

  group('DirectMessageStarter', () {
    test('resolves a started conversation to its route', () async {
      final starter = DirectMessageStarter(
        MockMessagingRepository(latency: Duration.zero),
      );
      final result = await starter.start('mock-peer-1');
      expect(
        result,
        isA<OpenConversation>().having(
          (r) => r.location,
          'location',
          Routes.conversation('mock-direct-mock-peer-1'),
        ),
      );
    });

    test('turns a refusal into a readable message, nothing to open', () async {
      final starter = DirectMessageStarter(
        MockMessagingRepository(latency: Duration.zero),
      );
      final result = await starter.start('mock-admin'); // an administrator — refused
      expect(
        result,
        isA<CannotStartDm>().having(
          (r) => r.message,
          'message',
          MessagingCopy.dmUnavailable('messaging.participant_not_eligible'),
        ),
      );
    });
  });

  group('messaging a co-member from a chat', () {
    const student = CurrentUser(
      id: 'mock-student',
      displayName: 'طالب تجريبي',
      status: AccountStatus.active,
      roles: ['STUDENT'],
      permissions: {
        'messaging.read',
        'messaging.send',
        'messaging.start_direct_peer',
        'messaging.start_direct_teacher',
      },
    );

    List<Override> asStudent(MessagingRepository messaging) => [
      messagingRepositoryProvider.overrideWithValue(messaging),
      sessionUserProvider.overrideWith((ref) async => student),
    ];

    testWidgets('tapping a peer\'s name starts a DM and opens it', (tester) async {
      final messaging = MockMessagingRepository(latency: Duration.zero);
      final container = await openApp(
        tester,
        Routes.conversation('mock-group'), // the demo group chat: peers post here
        overrides: asStudent(messaging),
      );

      // أحمد (mock-peer-1) posts in the group; his name is the entry point.
      await tester.tap(find.byKey(const Key('message-author-mock-peer-1')).first);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('start-dm-mock-peer-1')));
      await tester.pumpAndSettle();

      expect(
        locationIn(container),
        Routes.conversation('mock-direct-mock-peer-1'),
      );
    });

    testWidgets('tapping a teacher\'s name in a shared chat starts a DM and opens it (Q6)', (
      tester,
    ) async {
      final messaging = MockMessagingRepository(latency: Duration.zero);
      final container = await openApp(
        tester,
        Routes.conversation('mock-group'), // الأستاذ عبدالله (mock-teacher) posts here
        overrides: asStudent(messaging),
      );

      await tester.tap(find.byKey(const Key('message-author-mock-teacher')).first);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('start-dm-mock-teacher')));
      await tester.pumpAndSettle();

      // The demo already seeds a conversation with this teacher: starting one
      // reuses it (canonical), and opens it by its id.
      expect(locationIn(container), Routes.conversation('mock-direct'));
    });

    testWidgets('tapping an administrator\'s name is refused, and stays put', (tester) async {
      final messaging = MockMessagingRepository(latency: Duration.zero);
      final container = await openApp(
        tester,
        Routes.conversation('mock-channel'), // إدارة المعهد (mock-admin) posts here
        overrides: asStudent(messaging),
      );

      await tester.tap(find.byKey(const Key('message-author-mock-admin')).first);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('start-dm-mock-admin')));
      await tester.pumpAndSettle();

      expect(
        find.text(MessagingCopy.dmUnavailable('messaging.participant_not_eligible')),
        findsOneWidget,
      );
      expect(locationIn(container), Routes.conversation('mock-channel')); // did not move
    });

    testWidgets('a viewer whose account cannot start one sees no author affordance', (
      tester,
    ) async {
      const reader = CurrentUser(
        id: 'mock-student',
        displayName: 'طالب',
        status: AccountStatus.active,
        roles: ['STUDENT'],
        permissions: {'messaging.read', 'messaging.send'}, // no start permission
      );
      await openApp(
        tester,
        Routes.conversation('mock-group'),
        overrides: [
          messagingRepositoryProvider.overrideWithValue(
            MockMessagingRepository(latency: Duration.zero),
          ),
          sessionUserProvider.overrideWith((ref) async => reader),
        ],
      );
      expect(find.byKey(const Key('message-author-mock-peer-1')), findsNothing);
    });
  });
}

/// Enough of [AuthRepository] for the HTTP messaging repo's `viewerId`, which
/// `startDirect` does not call.
class _StubAuth implements AuthRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}
