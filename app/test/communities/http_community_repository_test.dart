import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/http/http_auth_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_community_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_messaging_repository.dart';

import 'community_test_support.dart';

/// The repositories against a scripted server: the exact routes the backend
/// serves, every refusal mapped to its stable code, and anything unreadable
/// reported as such rather than thrown raw.
void main() {
  final base = Uri.parse('https://api.example.org/');

  Future<ApiClient> api(http.Client client, {bool signedIn = true}) async {
    final store = InMemoryTokenStore();
    if (signedIn) {
      await store.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
    }
    return ApiClient(baseUri: base, httpClient: client, tokenStore: store);
  }

  Matcher refusedWith(String code) =>
      throwsA(isA<CommunityException>().having((e) => e.code, 'code', code));

  group('HttpCommunityRepository', () {
    test('lists the viewer’s own communities, a page at a time', () async {
      final server = CommunityServer({
        'GET /communities': (request) => jsonResponse(200, {
          'items': [
            communityJson(id: 'c-1'),
            communityJson(id: 'c-2', status: 'LOCKED'),
          ],
          'nextCursor': request.url.queryParameters['cursor'] == null
              ? 'next page'
              : null,
        }),
      });
      final repo = HttpCommunityRepository(await api(server.client));

      final first = await repo.communities();
      expect(first.items.map((c) => c.id), ['c-1', 'c-2']);
      expect(first.items.every((c) => c.origin == DataOrigin.records), isTrue);
      expect(first.nextCursor, 'next page');

      final second = await repo.communities(cursor: first.nextCursor);
      expect(second.nextCursor, isNull);

      expect(server.requests.first.url.queryParameters, {'scope': 'mine'});
      expect(server.requests.last.url.queryParameters, {
        'scope': 'mine',
        'cursor': 'next page',
      });
      expect(server.requests.first.headers['authorization'], 'Bearer a1');
    });

    test('reads one community by its encoded id', () async {
      final server = CommunityServer({
        'GET /communities/a%2Fb': (_) =>
            jsonResponse(200, communityJson(id: 'a/b', lifecycleVersion: 7)),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      final community = await repo.community('a/b');
      expect(community.id, 'a/b');
      expect(community.lifecycleVersion, 7);
      expect(server.calls, ['GET /communities/a%2Fb']);
    });

    test('reads a roster page by cursor, and never asks for more', () async {
      final server = CommunityServer({
        'GET /communities/c-1/members': (request) => jsonResponse(200, {
          'items': [
            memberJson('u-1'),
            memberJson('u-2', displayName: null, active: false),
          ],
          'nextCursor': 'more',
        }),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      final page = await repo.members('c-1');
      expect(page.items.map((m) => m.userId), ['u-1', 'u-2']);
      expect(page.items.last.active, isFalse);
      expect(page.nextCursor, 'more');
      await repo.members('c-1', cursor: 'more');
      expect(server.requests.first.url.queryParameters, isEmpty);
      expect(server.requests.last.url.queryParameters, {'cursor': 'more'});
      expect(server.requests, hasLength(2));
    });

    test('reports "not found" as gone', () async {
      final server = CommunityServer({
        'GET /communities/c-9': (_) =>
            refusal(404, 'communities.community_not_found'),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      await expectLater(
        repo.community('c-9'),
        throwsA(
          isA<CommunityException>().having((e) => e.isGone, 'gone', true),
        ),
      );
    });

    test('reports a roster refusal as forbidden', () async {
      final server = CommunityServer({
        'GET /communities/c-1/members': (_) =>
            refusal(403, 'communities.capability_required'),
        'GET /communities/c-2/members': (_) =>
            refusal(403, 'identity.permission_denied'),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      for (final id in ['c-1', 'c-2']) {
        await expectLater(
          repo.members(id),
          throwsA(
            isA<CommunityException>().having(
              (e) => e.isForbidden,
              'forbidden',
              true,
            ),
          ),
        );
      }
    });

    test(
      'asks for a sign-in when nobody is signed in, or the session ended',
      () async {
        final nobody = HttpCommunityRepository(
          await api(CommunityServer({}).client, signedIn: false),
        );
        await expectLater(
          nobody.communities(),
          throwsA(
            isA<CommunityException>().having(
              (e) => e.needsSignIn,
              'sign in',
              true,
            ),
          ),
        );

        final ended = CommunityServer({
          'GET /communities': (_) =>
              refusal(401, 'identity.authentication_required'),
          'POST /auth/refresh': (_) => refusal(401, 'identity.refresh_invalid'),
        });
        await expectLater(
          HttpCommunityRepository(await api(ended.client)).communities(),
          refusedWith('identity.authentication_required'),
        );
      },
    );

    test('reports an unreachable server as a network failure', () async {
      final offline = MockClient((_) async => throw http.ClientException('x'));
      await expectLater(
        HttpCommunityRepository(await api(offline)).community('c-1'),
        throwsA(
          isA<CommunityException>().having((e) => e.isNetwork, 'network', true),
        ),
      );
    });

    test(
      'reports what it cannot read as unreadable, never a raw error',
      () async {
        final server = CommunityServer({
          'GET /communities/c-1': (_) =>
              jsonResponse(200, communityJson()..remove('id')),
          'GET /communities': (_) => jsonResponse(200, ['not', 'a', 'page']),
        });
        final repo = HttpCommunityRepository(await api(server.client));
        await expectLater(
          repo.community('c-1'),
          refusedWith('communities.unreadable'),
        );
        await expectLater(
          repo.communities(),
          refusedWith('communities.unreadable'),
        );
      },
    );
  });

  group('HttpMessagingRepository.conversationForCommunity', () {
    Map<String, Object?> chat() => {
      'id': 'conv-7',
      'type': 'CHANNEL',
      'communityId': 'c/1',
      'title': 'مجتمع الخادم',
      'counterpartUserId': null,
      'memberCount': 30000,
      'myRole': 'MEMBER',
      'canPost': false,
      'canManageMembers': false,
      'lastSequence': 0,
      'lastReadSequence': 0,
      'unreadCount': 0,
      'lastMessage': null,
      'createdAt': '2026-09-01T08:00:00.000Z',
      'activityAt': '2026-09-01T08:00:00.000Z',
    };

    test('resolves the chat from the community, by the encoded id', () async {
      final server = CommunityServer({
        'GET /messaging/communities/c%2F1/conversation': (_) =>
            jsonResponse(200, chat()),
      });
      final client = await api(server.client);
      final repo = HttpMessagingRepository(client, HttpAuthRepository(client));
      final conversation = await repo.conversationForCommunity('c/1');
      expect(conversation.id, 'conv-7');
      expect(conversation.type, ConversationType.channel);
      expect(conversation.communityId, 'c/1');
      expect(conversation.canPost, isFalse);
    });

    test('maps its refusals to the server’s codes', () async {
      final server = CommunityServer({
        'GET /messaging/communities/gone/conversation': (_) =>
            refusal(404, 'messaging.conversation_not_found'),
        'GET /messaging/communities/busy/conversation': (_) =>
            refusal(429, 'messaging.too_many_community_chat_lookups'),
      });
      final client = await api(server.client);
      final repo = HttpMessagingRepository(client, HttpAuthRepository(client));
      for (final (id, code) in [
        ('gone', 'messaging.conversation_not_found'),
        ('busy', 'messaging.too_many_community_chat_lookups'),
      ]) {
        await expectLater(
          repo.conversationForCommunity(id),
          throwsA(
            isA<MessagingException>().having((e) => e.code, 'code', code),
          ),
        );
      }
    });
  });
}
