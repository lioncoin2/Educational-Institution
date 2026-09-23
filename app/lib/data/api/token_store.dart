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
/// PRODUCTION REQUIREMENT: a secure-storage implementation — Keychain on iOS,
/// Keystore-backed storage on Android — so tokens survive restarts without
/// sitting in plain preferences. The vetted candidate is
/// `flutter_secure_storage` (BSD-3, all platforms); it is not added in this
/// milestone because its native builds cannot be verified in this
/// environment (docs/architecture/messaging.md, "Client dependencies").
///
/// Until then [InMemoryTokenStore] is used: correct, and forgets on restart.
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
