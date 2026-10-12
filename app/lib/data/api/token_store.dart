/// The pair of tokens a signed-in device holds.
class Tokens {
  const Tokens({required this.accessToken, required this.refreshToken});

  final String accessToken;
  final String refreshToken;

  /// Never prints a token — not in logs, not in a failed test's output.
  @override
  String toString() => 'Tokens(<redacted>)';
}

/// Where tokens live between requests.
///
/// Two implementations: `SecureTokenStore` against the real backend — iOS
/// Keychain, Android Keystore-backed storage — so a signed-in device survives
/// a restart (Sprint 19); and [InMemoryTokenStore] for the demo build and
/// tests, which forgets on restart. `tokenStoreProvider` picks by mode. The
/// native builds of `flutter_secure_storage` are verified on a device, not in
/// this environment (docs/architecture/messaging.md, "Client dependencies").
abstract interface class TokenStore {
  Future<Tokens?> read();
  Future<void> write(Tokens tokens);
  Future<void> clear();
}

class InMemoryTokenStore implements TokenStore {
  Tokens? _tokens;

  @override
  Future<Tokens?> read() async => _tokens;

  @override
  Future<void> write(Tokens tokens) async => _tokens = tokens;

  @override
  Future<void> clear() async => _tokens = null;
}
