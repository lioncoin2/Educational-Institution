import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/secure_token_store.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/repositories/http/http_auth_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_auth_repository.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// A deterministic stand-in for the platform keystore, seedable and inspectable.
class _FakeKeychain implements SecureKeyValueStore {
  _FakeKeychain([Map<String, String>? seed]) {
    if (seed != null) entries.addAll(seed);
  }

  final Map<String, String> entries = {};

  @override
  Future<String?> read(String key) async => entries[key];
  @override
  Future<void> write(String key, String value) async => entries[key] = value;
  @override
  Future<void> delete(String key) async => entries.remove(key);
}

Map<String, String> _session(String id) => {
  'auth.accessToken': 'acc-$id',
  'auth.refreshToken': 'ref-$id',
};

http.Response _json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

http.Response _err(int status, String code) =>
    _json(status, {'error': {'code': code, 'message': code}});

Map<String, Object?> _userJson(String id) => {
  'id': id,
  'displayName': 'User $id',
  'status': 'ACTIVE',
  'roles': ['STUDENT'],
  'permissions': <String>[],
};

final _base = Uri.parse('https://api.test/');

HttpAuthRepository _repo(http.Client client, SecureKeyValueStore keychain) =>
    HttpAuthRepository(
      ApiClient(
        baseUri: _base,
        httpClient: client,
        tokenStore: SecureTokenStore(keychain),
      ),
    );

void main() {
  test('a sign-in persists the session, and a fresh store restores it on cold start', () async {
    final keychain = _FakeKeychain();
    final client = MockClient((request) async {
      switch (request.url.path) {
        case '/auth/login':
          return _json(200, {
            'accessToken': 'acc-A',
            'refreshToken': 'ref-A',
            'user': _userJson('A'),
          });
        case '/auth/me':
          // The restored session attaches its bearer to protected requests.
          expect(request.headers['authorization'], 'Bearer acc-A');
          return _json(200, _userJson('A'));
      }
      return _json(404, const {});
    });

    final signedIn = await _repo(
      client,
      keychain,
    ).signIn(identifier: 'u', password: 'p');
    expect(signedIn.id, 'A');
    // Persisted, not held in memory.
    expect(keychain.entries, _session('A'));

    // Cold restart: a brand-new store over the same keystore.
    final restored = await _repo(client, keychain).currentUser();
    expect(restored, isNotNull);
    expect(restored!.id, 'A');
  });

  test('no stored session restores nobody and never calls /auth/me', () async {
    var meHits = 0;
    final client = MockClient((request) async {
      if (request.url.path == '/auth/me') meHits++;
      return _json(404, const {});
    });
    expect(await _repo(client, _FakeKeychain()).currentUser(), isNull);
    expect(meHits, 0);
  });

  test('a rejected stored credential clears the keystore and signs out', () async {
    final keychain = _FakeKeychain(_session('stale'));
    final client = MockClient((request) async {
      switch (request.url.path) {
        case '/auth/me':
          return _err(401, 'identity.authentication_required');
        case '/auth/refresh':
          return _err(401, 'identity.refresh_rejected');
      }
      return _json(404, const {});
    });

    expect(await _repo(client, keychain).currentUser(), isNull);
    expect(
      keychain.entries,
      isEmpty,
      reason: 'a refused refresh clears the stored session',
    );
  });

  test('logout clears the persisted session', () async {
    final keychain = _FakeKeychain(_session('A'));
    final client = MockClient(
      (request) async =>
          request.url.path == '/auth/logout' ? _json(200, const {}) : _json(404, const {}),
    );
    await _repo(client, keychain).signOut();
    expect(keychain.entries, isEmpty);
  });

  test('a new sign-in replaces the previous stored session', () async {
    final keychain = _FakeKeychain();
    var who = 'A';
    final client = MockClient((request) async {
      if (request.url.path == '/auth/login') {
        return _json(200, {
          'accessToken': 'acc-$who',
          'refreshToken': 'ref-$who',
          'user': _userJson(who),
        });
      }
      return _json(404, const {});
    });
    final repo = _repo(client, keychain);

    await repo.signIn(identifier: 'u', password: 'p');
    who = 'B';
    await repo.signIn(identifier: 'u2', password: 'p2');

    expect(keychain.entries, _session('B'));
    expect((await repo.currentUser())?.id, 'B');
  });

  test('concurrent restoration is single-flight at the session provider', () async {
    var meHits = 0;
    final keychain = _FakeKeychain(_session('A'));
    final client = MockClient((request) async {
      if (request.url.path == '/auth/me') {
        meHits++;
        return _json(200, _userJson('A'));
      }
      return _json(404, const {});
    });
    final container = ProviderContainer(
      overrides: [
        backendModeProvider.overrideWithValue(true),
        httpClientProvider.overrideWithValue(client),
        tokenStoreProvider.overrideWithValue(SecureTokenStore(keychain)),
        apiClientProvider.overrideWith(
          (ref) => ApiClient(
            baseUri: _base,
            httpClient: client,
            tokenStore: ref.watch(tokenStoreProvider),
            onSignedOut: () => ref.container.invalidate(sessionUserProvider),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    final results = await Future.wait([
      container.read(sessionUserProvider.future),
      container.read(sessionUserProvider.future),
    ]);

    expect(meHits, 1, reason: 'two watchers share one restoration');
    expect(results[0]?.id, 'A');
    expect(results[1]?.id, 'A');
  });

  test('a slow restoration never overwrites a newer sign-in (stale guard)', () async {
    final gate = Completer<void>();
    final keychain = _FakeKeychain(_session('A'));
    final client = MockClient((request) async {
      switch (request.url.path) {
        case '/auth/me':
          await gate.future; // hold the restoration open
          return _json(200, _userJson('A'));
        case '/auth/login':
          return _json(200, {
            'accessToken': 'acc-B',
            'refreshToken': 'ref-B',
            'user': _userJson('B'),
          });
      }
      return _json(404, const {});
    });
    final repo = _repo(client, keychain);

    final restore = repo.currentUser(); // begins /auth/me, blocks
    final signedIn = await repo.signIn(identifier: 'u', password: 'p'); // lands first
    gate.complete(); // release the now-stale restoration
    final stale = await restore;

    expect(signedIn.id, 'B');
    expect(stale?.id, 'B', reason: 'the stale restoration must not resurrect A');
    expect((await repo.currentUser())?.id, 'B');
    expect(keychain.entries, _session('B'));
  });

  test('a logout during restoration wins — the old session is not resurrected', () async {
    final gate = Completer<void>();
    final keychain = _FakeKeychain(_session('A'));
    final client = MockClient((request) async {
      switch (request.url.path) {
        case '/auth/me':
          await gate.future;
          return _json(200, _userJson('A'));
        case '/auth/logout':
          return _json(200, const {});
      }
      return _json(404, const {});
    });
    final repo = _repo(client, keychain);

    final restore = repo.currentUser();
    await repo.signOut();
    gate.complete();
    final stale = await restore;

    expect(stale, isNull, reason: 'logout during restoration must not restore the old user');
    expect(keychain.entries, isEmpty);
    expect(await repo.currentUser(), isNull);
  });

  test('the token store is secure in backend mode and in-memory in demo mode', () {
    final backend = ProviderContainer(
      overrides: [backendModeProvider.overrideWithValue(true)],
    );
    addTearDown(backend.dispose);
    expect(backend.read(tokenStoreProvider), isA<SecureTokenStore>());
    expect(backend.read(authRepositoryProvider), isA<HttpAuthRepository>());

    final demo = ProviderContainer(
      overrides: [backendModeProvider.overrideWithValue(false)],
    );
    addTearDown(demo.dispose);
    expect(demo.read(tokenStoreProvider), isA<InMemoryTokenStore>());
    expect(demo.read(authRepositoryProvider), isA<MockAuthRepository>());
  });
}
