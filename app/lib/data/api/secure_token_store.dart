import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'token_store.dart';

/// The two keys the session's tokens live under in the platform keystore.
/// Namespaced so they never collide with anything else a keychain may hold.
const String _kAccessToken = 'auth.accessToken';
const String _kRefreshToken = 'auth.refreshToken';

/// The platform keystore itself failed — not "no session", but the secure
/// store could not be read, written or cleared. Carries no token material, so
/// it is safe to log or surface; the operation that failed is named for
/// diagnostics only.
class TokenStorageException implements Exception {
  const TokenStorageException(this.operation, [this.cause]);

  /// `'read'`, `'write'` or `'clear'`.
  final String operation;
  final Object? cause;

  @override
  String toString() => 'TokenStorageException($operation)';
}

/// The narrow secure key/value surface [SecureTokenStore] needs: three async
/// string operations. One real implementation ([_Keychain], backed by the
/// platform keystore) and a deterministic fake in tests — so the store's own
/// logic (serialisation, the both-or-nothing rule, failure handling) is
/// covered on the VM, without a device.
abstract interface class SecureKeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// [SecureKeyValueStore] over `flutter_secure_storage` — iOS Keychain, Android
/// AES-GCM Keystore-backed storage, the Web Crypto store on web. This is the
/// ONE file allowed to import the package (enforced by
/// test/auth/secure_token_store_boundaries_test.dart), mirroring the
/// livekit_client confinement (ADR 0030). The package's defaults are used:
/// AES-GCM on Android, the default Keychain accessibility on iOS.
class _Keychain implements SecureKeyValueStore {
  const _Keychain();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// A [TokenStore] that keeps the session's tokens in platform secure storage,
/// so a signed-in device survives a cold restart. Wired in backend mode only;
/// the demo build has no server session to keep and stays on
/// [InMemoryTokenStore] (see `tokenStoreProvider`).
///
/// A keystore failure is raised as a [TokenStorageException] — never swallowed
/// into a silent sign-out, and never downgraded to insecure persistent
/// storage. The caller's existing "signed out / recoverable error" handling
/// then applies.
class SecureTokenStore implements TokenStore {
  /// Production: the platform keychain. Tests pass a fake [SecureKeyValueStore].
  SecureTokenStore([SecureKeyValueStore backing = const _Keychain()])
    : _store = backing;

  final SecureKeyValueStore _store;

  @override
  Future<Tokens?> read() async {
    final String? access;
    final String? refresh;
    try {
      access = await _store.read(_kAccessToken);
      refresh = await _store.read(_kRefreshToken);
    } catch (error) {
      throw TokenStorageException('read', error);
    }
    // A session is both tokens or none: half a pair can neither authenticate a
    // request nor be refreshed, so a partial read is treated as no session.
    if (access == null || access.isEmpty) return null;
    if (refresh == null || refresh.isEmpty) return null;
    return Tokens(accessToken: access, refreshToken: refresh);
  }

  @override
  Future<void> write(Tokens tokens) async {
    try {
      await _store.write(_kAccessToken, tokens.accessToken);
      await _store.write(_kRefreshToken, tokens.refreshToken);
    } catch (error) {
      throw TokenStorageException('write', error);
    }
  }

  @override
  Future<void> clear() async {
    try {
      await _store.delete(_kAccessToken);
      await _store.delete(_kRefreshToken);
    } catch (error) {
      throw TokenStorageException('clear', error);
    }
  }
}
