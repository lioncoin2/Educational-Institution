import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/client_ids.dart';
import 'package:quran_institution_app/data/api/refresh_lock.dart';
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

  group('a PUT', () {
    test('sends JSON with the bearer token, and decodes the answer', () async {
      final seen = <http.Request>[];
      final api = ApiClient(
        baseUri: base,
        httpClient: MockClient((request) async {
          seen.add(request);
          return json(200, {'id': 'c-1'});
        }),
        tokenStore: await signedIn(),
      );
      expect(await api.put('/communities/c-1/owner', body: {'userId': 'u-2'}), {
        'id': 'c-1',
      });
      final request = seen.single;
      expect(request.method, 'PUT');
      expect(
        request.url.toString(),
        'https://api.example.org/communities/c-1/owner',
      );
      expect(request.headers['authorization'], 'Bearer access-1');
      expect(request.headers['content-type'], startsWith('application/json'));
      expect(jsonDecode(request.body), {'userId': 'u-2'});
    });

    test(
      'renews an expired token once, then sends the same body again',
      () async {
        final seen = <http.Request>[];
        final api = ApiClient(
          baseUri: base,
          httpClient: MockClient((request) async {
            seen.add(request);
            if (request.url.path == '/auth/refresh') {
              return json(200, {
                'accessToken': 'access-2',
                'refreshToken': 'refresh-2',
              });
            }
            return request.headers['authorization'] == 'Bearer access-2'
                ? json(200, {'ok': true})
                : error(401, 'identity.authentication_required');
          }),
          tokenStore: await signedIn(),
        );
        expect(await api.put('/x', body: {'userId': 'u-2'}), {'ok': true});
        expect(seen.map((r) => '${r.method} ${r.url.path}'), [
          'PUT /x',
          'POST /auth/refresh',
          'PUT /x',
        ]);
        expect(seen.last.body, seen.first.body);
        expect(jsonDecode(seen.last.body), {'userId': 'u-2'});
      },
    );

    test('maps a refusal, with its details', () async {
      final api = ApiClient(
        baseUri: base,
        httpClient: MockClient(
          (_) async => json(422, {
            'error': {
              'kind': 'validation',
              'code': 'communities.owner_ineligible',
              'message': 'x',
              'details': {'field': 'userId'},
            },
            'requestId': 'r-1',
          }),
        ),
        tokenStore: await signedIn(),
      );
      await expectLater(
        api.put('/x', body: const {}),
        throwsA(
          isA<ApiException>()
              .having((e) => e.status, 'status', 422)
              .having((e) => e.code, 'code', 'communities.owner_ineligible')
              .having((e) => e.details, 'details', {'field': 'userId'}),
        ),
      );
    });
  });

  test('a POST without a body sends none — no content type either', () async {
    final seen = <http.Request>[];
    final api = ApiClient(
      baseUri: base,
      httpClient: MockClient((request) async {
        seen.add(request);
        return http.Response('', 204);
      }),
      tokenStore: await signedIn(),
    );
    expect(await api.post('/communities/c-1/leave'), isEmpty);
    expect(await api.post('/x', body: const <String, Object?>{}), isEmpty);
    expect(seen.first.body, isEmpty);
    expect(seen.first.headers.containsKey('content-type'), isFalse);
    expect(seen.first.headers['authorization'], 'Bearer access-1');
    // An empty object is a body: sent as one.
    expect(seen.last.body, '{}');
    expect(seen.last.headers['content-type'], startsWith('application/json'));
  });

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

  // A refresh answer that is not about the session — an outage, a gateway error
  // or the rate limit — must not sign the user out.
  group('a refresh the server could not serve', () {
    for (final status in [429, 500, 502, 503, 504]) {
      test('$status keeps the session and reports the server unreachable', () async {
        var signedOut = false;
        final client = MockClient(
          (request) async => request.url.path == '/auth/refresh'
              ? http.Response('<html>upstream unavailable</html>', status)
              : error(401, 'identity.authentication_required'),
        );
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
            isA<ApiException>().having((e) => e.isUnreachable, 'unreachable', true),
          ),
        );
        expect(signedOut, isFalse);
        expect((await store.read())?.refreshToken, 'refresh-1');
      });
    }

    test('403 (an inactive account) still ends the session', () async {
      var signedOut = false;
      final client = MockClient(
        (request) async => request.url.path == '/auth/refresh'
            ? error(403, 'identity.account_suspended')
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
    });
  });

  // Two browser tabs share one token store (the origin's storage) but run two
  // clients. Their realtime sockets renew at the same instant, 60 s before the
  // same expiry. The server rotates refresh tokens and ends the session when a
  // spent one comes back — the `refresh_reuse_detected / concurrent` sign-outs
  // seen on the Trial.
  group('two tabs renewing together', () {
    Future<
      ({
        _RotatingServer server,
        InMemoryTokenStore store,
        List<String?> results,
        List<bool> signedOut,
      })
    >
    renewBoth(RefreshLock Function() lockFor) async {
      final server = _RotatingServer();
      final store = await signedIn();
      final signedOut = [false, false];
      final tabs = [
        for (var i = 0; i < 2; i++)
          ApiClient(
            baseUri: base,
            httpClient: MockClient(server.handle),
            tokenStore: store,
            onSignedOut: () => signedOut[i] = true,
            refreshLock: lockFor(),
          ),
      ];
      final renewals = [for (final tab in tabs) tab.accessToken(renew: true)];
      await Future<void>.delayed(Duration.zero);
      server.release();
      final results = await Future.wait(renewals);
      return (
        server: server,
        store: store,
        results: results,
        signedOut: signedOut,
      );
    }

    test('without a shared lock the server ends the session (the reported '
        'sign-out)', () async {
      final r = await renewBoth(() => const InProcessRefreshLock());
      expect(r.server.reuseDetected, isTrue);
      expect(r.signedOut, contains(true));
    });

    test('with the shared lock one refresh is sent and both tabs stay signed '
        'in', () async {
      final shared = _SharedLock();
      final r = await renewBoth(() => shared);
      expect(r.server.refreshes, 1);
      expect(r.server.reuseDetected, isFalse);
      expect(r.signedOut, [false, false]);
      expect(r.results, everyElement('access-2'));
      expect((await r.store.read())?.refreshToken, 'refresh-2');
    });
  });
}

/// The server's refresh rule: the current token rotates; the previous one,
/// presented again, ends the session (reuse detection); responses are held
/// until [release] so two requests can be in flight together.
class _RotatingServer {
  var _current = 'refresh-1';
  String? _previous;
  var _generation = 1;
  var ended = false;
  var reuseDetected = false;
  var refreshes = 0;
  final _gate = Completer<void>();

  void release() => _gate.complete();

  Future<http.Response> handle(http.Request request) async {
    if (request.url.path != '/auth/refresh') {
      return error(401, 'identity.authentication_required');
    }
    final presented =
        (jsonDecode(request.body) as Map)['refreshToken'] as String;
    await _gate.future;
    if (!ended && presented == _current) {
      refreshes++;
      _generation++;
      _previous = _current;
      _current = 'refresh-$_generation';
      return json(200, {
        'accessToken': 'access-$_generation',
        'refreshToken': _current,
      });
    }
    if (presented == _previous) {
      ended = true;
      reuseDetected = true;
    }
    return error(401, 'identity.refresh_token_invalid');
  }
}

/// One lock shared by both "tabs", like the browser's Web Locks API.
class _SharedLock implements RefreshLock {
  Future<void> _tail = Future<void>.value();

  @override
  Future<T> run<T>(Future<T> Function() body) {
    final previous = _tail;
    final done = Completer<void>();
    _tail = done.future;
    return previous.then((_) => body()).whenComplete(done.complete);
  }
}
