import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/repositories/http/http_notifications_repository.dart';

import '../messaging/http_repositories_test.dart' show FakeServer, error, json;
import 'notification_models_test.dart' show notificationJson;

void main() {
  final base = Uri.parse('https://api.example.org/');

  Future<HttpNotificationsRepository> repository(FakeServer server) async {
    final store = InMemoryTokenStore();
    await store.write(const Tokens(accessToken: 'a', refreshToken: 'r'));
    return HttpNotificationsRepository(
      ApiClient(baseUri: base, httpClient: server.client, tokenStore: store),
    );
  }

  Map<String, Object?> bodyOf(http.Request request) =>
      (jsonDecode(request.body) as Map).cast<String, Object?>();

  test('lists a page, passing the cursor back as it was given', () async {
    final server = FakeServer({
      'GET /notifications': (request) {
        expect(request.headers['authorization'], 'Bearer a');
        return json(200, {
          'items': [notificationJson(id: 'n-2'), notificationJson(id: 'n-1')],
          'nextCursor': request.url.queryParameters['cursor'] == null
              ? 'c2'
              : null,
        });
      },
    });
    final repo = await repository(server);
    final first = await repo.list();
    expect(first.items.map((n) => n.id), ['n-2', 'n-1']);
    expect(first.nextCursor, 'c2');
    final second = await repo.list(cursor: 'c2', limit: 10);
    expect(second.nextCursor, isNull);
    expect(server.requests.last.url.queryParameters, {
      'cursor': 'c2',
      'limit': '10',
    });
  });

  test('counts unread, capped', () async {
    final server = FakeServer({
      'GET /notifications/unread-count': (_) =>
          json(200, {'count': 99, 'capped': true}),
    });
    expect(
      await (await repository(server)).unreadCount(),
      const UnreadCount(99, capped: true),
    );
  });

  test(
    'marks one read by its (encoded) id, and all read up to a boundary',
    () async {
      final server = FakeServer({
        // The id travels percent-encoded: it is a path segment, never a path.
        'POST /notifications/n%201/read': (_) => json(
          200,
          notificationJson(id: 'n 1', readAt: '2026-09-01T09:00:00.000Z'),
        ),
        'POST /notifications/read-all': (request) {
          expect(bodyOf(request), {'throughId': 'n-9'});
          return json(200, {'markedRead': 4, 'complete': true});
        },
      });
      final repo = await repository(server);
      final read = await repo.markRead('n 1');
      expect(read.isRead, isTrue);
      expect(
        server.requests.first.url.toString(),
        endsWith('/notifications/n%201/read'),
      );
      expect(await repo.markAllRead(throughId: 'n-9'), 4);
    },
  );

  test(
    'reads and changes preferences, sending only the switches that change',
    () async {
      final server = FakeServer({
        'GET /notifications/preferences': (_) => json(200, {
          'categories': [
            {
              'category': 'MESSAGES',
              'inApp': true,
              'realtime': true,
              'push': true,
            },
          ],
        }),
        'PATCH /notifications/preferences': (request) {
          expect(bodyOf(request), {'category': 'MESSAGES', 'push': false});
          return json(200, {
            'categories': [
              {
                'category': 'MESSAGES',
                'inApp': true,
                'realtime': true,
                'push': false,
              },
            ],
          });
        },
      });
      final repo = await repository(server);
      expect((await repo.preferences()).single.push, isTrue);
      expect(
        (await repo.updatePreferences('MESSAGES', push: false)).single.push,
        isFalse,
      );
    },
  );

  test('registers a device with its token, and unregisters it by id', () async {
    final server = FakeServer({
      'POST /notifications/devices': (request) {
        expect(bodyOf(request), {
          'platform': 'ANDROID',
          'provider': 'FCM',
          'token': 'fcm-token-value',
        });
        return json(200, {
          'id': 'd-1',
          'platform': 'ANDROID',
          'provider': 'FCM',
          'createdAt': '2026-09-01T08:00:00.000Z',
          'lastSeenAt': '2026-09-01T08:00:00.000Z',
        });
      },
      'DELETE /notifications/devices/d-1': (_) => http.Response('', 204),
    });
    final repo = await repository(server);
    final device = await repo.registerDevice(
      platform: 'ANDROID',
      provider: 'FCM',
      token: 'fcm-token-value',
    );
    expect(device.id, 'd-1');
    await repo.unregisterDevice('d-1');
    expect(server.calls, [
      'POST /notifications/devices',
      'DELETE /notifications/devices/d-1',
    ]);
  });

  test('reports a refusal with the server’s code', () async {
    final server = FakeServer({
      'POST /notifications/n-x/read': (_) =>
          error(404, 'notifications.notification_not_found'),
    });
    await expectLater(
      (await repository(server)).markRead('n-x'),
      throwsA(
        isA<NotificationsException>().having(
          (e) => e.code,
          'code',
          'notifications.notification_not_found',
        ),
      ),
    );
  });

  test(
    'says "sign in" when nobody is signed in — without asking the server',
    () async {
      final server = FakeServer({});
      final repo = HttpNotificationsRepository(
        ApiClient(
          baseUri: base,
          httpClient: server.client,
          tokenStore: InMemoryTokenStore(),
        ),
      );
      await expectLater(
        repo.unreadCount(),
        throwsA(
          isA<NotificationsException>().having(
            (e) => e.needsSignIn,
            'needsSignIn',
            isTrue,
          ),
        ),
      );
      expect(server.requests, isEmpty);
    },
  );
}
