import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/api/secure_token_store.dart';
import 'package:quran_institution_app/data/api/token_store.dart';

/// A deterministic stand-in for the platform keystore. Holds its entries in a
/// plain map the test can inspect, and can be told to fail — so the store's
/// own logic is exercised without a device. (The real [_Keychain] adapter that
/// talks to flutter_secure_storage is thin and only runs on a device; see the
/// report's platform-verification caveats.)
class _FakeKeychain implements SecureKeyValueStore {
  final Map<String, String> entries = {};
  bool failOnRead = false;
  bool failOnWrite = false;
  bool failOnDelete = false;

  @override
  Future<String?> read(String key) async {
    if (failOnRead) throw const _KeystoreDown();
    return entries[key];
  }

  @override
  Future<void> write(String key, String value) async {
    if (failOnWrite) throw const _KeystoreDown();
    entries[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    if (failOnDelete) throw const _KeystoreDown();
    entries.remove(key);
  }
}

class _KeystoreDown implements Exception {
  const _KeystoreDown();
}

void main() {
  const tokens = Tokens(accessToken: 'access-1', refreshToken: 'refresh-1');

  test('write then read returns the same pair', () async {
    final keychain = _FakeKeychain();
    final store = SecureTokenStore(keychain);

    await store.write(tokens);

    // Observable storage contents: both keys hold the token values.
    expect(keychain.entries['auth.accessToken'], 'access-1');
    expect(keychain.entries['auth.refreshToken'], 'refresh-1');

    final read = await store.read();
    expect(read, isNotNull);
    expect(read!.accessToken, 'access-1');
    expect(read.refreshToken, 'refresh-1');
  });

  test('persists across a new store over the same keystore (a cold restart)', () async {
    final keychain = _FakeKeychain();
    await SecureTokenStore(keychain).write(tokens);

    // The process restarts: a fresh store instance, the same keystore.
    final afterRestart = await SecureTokenStore(keychain).read();

    expect(afterRestart, isNotNull);
    expect(afterRestart!.accessToken, 'access-1');
    expect(afterRestart.refreshToken, 'refresh-1');
  });

  test('empty keystore reads as no session', () async {
    expect(await SecureTokenStore(_FakeKeychain()).read(), isNull);
  });

  test('a half-written pair is no session (and is not returned)', () async {
    final keychain = _FakeKeychain()..entries['auth.accessToken'] = 'orphan';
    expect(await SecureTokenStore(keychain).read(), isNull);

    final keychain2 = _FakeKeychain()..entries['auth.refreshToken'] = 'orphan';
    expect(await SecureTokenStore(keychain2).read(), isNull);
  });

  test('clear removes both entries', () async {
    final keychain = _FakeKeychain();
    final store = SecureTokenStore(keychain);
    await store.write(tokens);

    await store.clear();

    expect(keychain.entries, isEmpty);
    expect(await store.read(), isNull);
  });

  test('a second write replaces the previous pair (a new sign-in)', () async {
    final keychain = _FakeKeychain();
    final store = SecureTokenStore(keychain);
    await store.write(tokens);

    await store.write(
      const Tokens(accessToken: 'access-2', refreshToken: 'refresh-2'),
    );

    expect(keychain.entries['auth.accessToken'], 'access-2');
    expect(keychain.entries['auth.refreshToken'], 'refresh-2');
    final read = await store.read();
    expect(read!.accessToken, 'access-2');
    expect(read.refreshToken, 'refresh-2');
  });

  group('a keystore failure fails closed — never silent, never a downgrade', () {
    test('read failure surfaces TokenStorageException, not null', () async {
      final store = SecureTokenStore(_FakeKeychain()..failOnRead = true);
      await expectLater(
        store.read(),
        throwsA(
          isA<TokenStorageException>().having((e) => e.operation, 'op', 'read'),
        ),
      );
    });

    test('write failure surfaces TokenStorageException', () async {
      final store = SecureTokenStore(_FakeKeychain()..failOnWrite = true);
      await expectLater(
        store.write(tokens),
        throwsA(
          isA<TokenStorageException>().having((e) => e.operation, 'op', 'write'),
        ),
      );
    });

    test('clear failure surfaces TokenStorageException', () async {
      final keychain = _FakeKeychain()..failOnDelete = true;
      await SecureTokenStore(_FakeKeychain()).write(tokens); // unrelated
      final store = SecureTokenStore(keychain);
      await expectLater(
        store.clear(),
        throwsA(
          isA<TokenStorageException>().having((e) => e.operation, 'op', 'clear'),
        ),
      );
    });
  });

  test('no token material leaks through toString', () {
    expect(tokens.toString(), 'Tokens(<redacted>)');
    expect(tokens.toString(), isNot(contains('access-1')));
    expect(tokens.toString(), isNot(contains('refresh-1')));

    final failure = TokenStorageException('read', tokens);
    expect(failure.toString(), 'TokenStorageException(read)');
    expect(failure.toString(), isNot(contains('access-1')));
    expect(failure.toString(), isNot(contains('refresh-1')));
  });
}
