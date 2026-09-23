import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/client_ids.dart';
import 'package:quran_institution_app/data/api/token_store.dart';

http.Response json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

http.Response error(int status, String code) => json(status, {
  'error': {'kind': 'x', 'code': code, 'message': code},
});

void main() {
  final base = Uri.parse('https://api.example.org/');

  Future<InMemoryTokenStore> signedIn([String access = 'access-1']) async {
    final store = InMemoryTokenStore();
    await store.write(Tokens(accessToken: access, refreshToken: 'refresh-1'));
    return store;
  }

  test('sends the bearer token and decodes the body', () async {
    final client = MockClient((request) async {
      expect(
        request.url.toString(),
        'https://api.example.org/messaging/conversations?cursor=abc',
      );
      expect(request.headers['authorization'], 'Bearer access-1');
      return json(200, {'items': []});
    });
    final api = ApiClient(
      baseUri: base,
      httpClient: client,
      tokenStore: await signedIn(),
    );
    expect(
      await api.get('/messaging/conversations', query: {'cursor': 'abc'}),
      {'items': []},
    );
  });

  test(
    'turns the server error shape into ApiException with its code',
    () async {
      final client = MockClient(
        (_) async => error(404, 'messaging.conversation_not_found'),
      );
      final api = ApiClient(
        baseUri: base,
        httpClient: client,
        tokenStore: await signedIn(),
      );
      await expectLater(
        api.get('/messaging/conversations/x'),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 404)
              .having(
                (e) => e.code,
                'code',
                'messaging.conversation_not_found',
              ),
        ),
      );
    },
  );

  test(
    'refuses an authenticated call without tokens, without calling out',
    () async {
      var calls = 0;
      final client = MockClient((_) async {
        calls++;
        return json(200, {});
      });
      final api = ApiClient(
        baseUri: base,
        httpClient: client,
        tokenStore: InMemoryTokenStore(),
      );
      await expectLater(api.get('/auth/me'), throwsA(isA<ApiException>()));
      expect(calls, 0);
    },
  );

  // The server treats a refresh token presented twice as stolen: concurrent
  // 401s must share ONE refresh.
  test(
    'refreshes once for many concurrent expired requests, then retries them',
    () async {
      var refreshes = 0;
      final gate = Completer<void>();
      final client = MockClient((request) async {
        if (request.url.path == '/auth/refresh') {
          refreshes++;
          await gate.future;
          return json(200, {
            'accessToken': 'access-2',
            'refreshToken': 'refresh-2',
          });
        }
        return request.headers['authorization'] == 'Bearer access-2'
            ? json(200, {'ok': true})
            : error(401, 'identity.authentication_required');
      });
      final store = await signedIn();
      final api = ApiClient(
        baseUri: base,
        httpClient: client,
        tokenStore: store,
      );

      final calls = [
        for (var i = 0; i < 5; i++) api.get('/messaging/conversations'),
      ];
      await Future<void>.delayed(Duration.zero);
      gate.complete();
      expect(await Future.wait(calls), everyElement({'ok': true}));
      expect(refreshes, 1);
      expect((await store.read())?.accessToken, 'access-2');
    },
  );

  test(
    'a refused refresh ends the session: tokens cleared, sign-out reported',
    () async {
      var signedOut = false;
      final client = MockClient(
        (request) async => request.url.path == '/auth/refresh'
            ? error(401, 'identity.refresh_token_invalid')
            : error(401, 'identity.authentication_required'),
      );
      final store = await signedIn();
      final api = ApiClient(
        baseUri: base,
        httpClient: client,
        tokenStore: store,
        onSignedOut: () => signedOut = true,
      );
      await expectLater(api.get('/auth/me'), throwsA(isA<ApiException>()));
      expect(signedOut, isTrue);
      expect(await store.read(), isNull);
    },
  );

  test('a network failure during refresh is not a sign-out', () async {
    var signedOut = false;
    final client = MockClient((request) async {
      if (request.url.path == '/auth/refresh') {
        throw http.ClientException('offline');
      }
      return error(401, 'identity.authentication_required');
    });
    final store = await signedIn();
    final api = ApiClient(
      baseUri: base,
      httpClient: client,
      tokenStore: store,
      onSignedOut: () => signedOut = true,
    );
    await expectLater(
      api.get('/auth/me'),
      throwsA(
        isA<ApiException>().having(
          (e) => e.isUnreachable,
          'unreachable',
          isTrue,
        ),
      ),
    );
    expect(signedOut, isFalse);
    expect(await store.read(), isNotNull);
  });

  // A signed upload URL may point at a third-party object store: the bearer
  // token must never travel there.
  test(
    'uploads bytes without the bearer token, and accepts "already uploaded"',
    () async {
      final seen = <http.Request>[];
      final client = MockClient((request) async {
        seen.add(request);
        return http.Response('', seen.length == 1 ? 201 : 409);
      });
      final api = ApiClient(
        baseUri: base,
        httpClient: client,
        tokenStore: await signedIn(),
      );
      final url = api.resolve('/files/local/abc?sig=x');
      expect(url.toString(), 'https://api.example.org/files/local/abc?sig=x');
      expect(
        await api.putBytes(url, [1, 2, 3], {'content-type': 'image/png'}),
        201,
      );
      expect(
        await api.putBytes(url, [1, 2, 3], {'content-type': 'image/png'}),
        409,
      );
      expect(seen.first.headers.containsKey('authorization'), isFalse);
      expect(seen.first.bodyBytes, [1, 2, 3]);
    },
  );

  test('client ids are random UUIDs, version 4', () {
    final ids = {for (var i = 0; i < 200; i++) newClientId()};
    expect(ids, hasLength(200));
    for (final id in ids) {
      expect(
        id,
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
    }
  });

  test('tokens never print', () {
    expect(
      const Tokens(
        accessToken: 'secret-a',
        refreshToken: 'secret-r',
      ).toString(),
      isNot(contains('secret')),
    );
  });

  group('a token for the realtime connection', () {
    test('is the current access token, without calling out', () async {
      var calls = 0;
      final api = ApiClient(
        baseUri: base,
        httpClient: MockClient((_) async {
          calls += 1;
          return json(200, {});
        }),
        tokenStore: await signedIn(),
      );
      expect(await api.accessToken(), 'access-1');
      expect(calls, 0);
    });

    test('is null when nobody is signed in', () async {
      final api = ApiClient(
        baseUri: base,
        httpClient: MockClient((_) async => json(200, {})),
        tokenStore: InMemoryTokenStore(),
      );
      expect(await api.accessToken(renew: true), isNull);
    });

    test('renews through the one shared refresh — never two at once', () async {
      var refreshes = 0;
      final gate = Completer<void>();
      final api = ApiClient(
        baseUri: base,
        httpClient: MockClient((request) async {
          if (request.url.path == '/auth/refresh') {
            refreshes += 1;
            await gate.future;
            return json(200, {
              'accessToken': 'access-2',
              'refreshToken': 'refresh-2',
            });
          }
          return json(200, {});
        }),
        tokenStore: await signedIn(),
      );
      final socket = api.accessToken(renew: true);
      final another = api.accessToken(renew: true);
      gate.complete();
      expect(await socket, 'access-2');
      expect(await another, 'access-2');
      expect(refreshes, 1);
    });

    test('is null, and signs out, when the session is over', () async {
      var signedOut = false;
      final store = await signedIn();
      final api = ApiClient(
        baseUri: base,
        httpClient: MockClient(
          (_) async => error(401, 'identity.refresh_token_invalid'),
        ),
        tokenStore: store,
        onSignedOut: () => signedOut = true,
      );
      expect(await api.accessToken(renew: true), isNull);
      expect(signedOut, isTrue);
      expect(await store.read(), isNull);
    });

    test(
      'throws, keeping the session, when the server cannot be reached',
      () async {
        final store = await signedIn();
        final api = ApiClient(
          baseUri: base,
          httpClient: MockClient(
            (_) async => throw http.ClientException('down'),
          ),
          tokenStore: store,
        );
        await expectLater(
          api.accessToken(renew: true),
          throwsA(
            isA<ApiException>().having(
              (e) => e.isUnreachable,
              'unreachable',
              true,
            ),
          ),
        );
        expect(await store.read(), isNotNull);
      },
    );
  });
}
