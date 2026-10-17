import 'package:flutter/foundation.dart';

import '../../api/api_client.dart';
import '../../api/token_store.dart';
import '../../models/auth.dart';
import '../repositories.dart';

/// [AuthRepository] against the real backend (`/auth/*`).
///
/// Tokens go to the [TokenStore] and nowhere else — never logged, never
/// shown. Refresh is the [ApiClient]'s job, one request at a time.
class HttpAuthRepository implements AuthRepository {
  HttpAuthRepository(this._api);

  final ApiClient _api;
  CurrentUser? _user;

  /// Bumped on every known change to the session (sign-in, sign-out). A slow
  /// [currentUser] restoration that resolves after one of those must not
  /// overwrite the newer state with a stale `/auth/me` — it checks this.
  int _session = 0;

  @override
  Future<CurrentUser> signIn({
    required String identifier,
    required String password,
  }) async {
    try {
      final json = await _api.post(
        '/auth/login',
        authenticated: false,
        body: {
          'identifier': identifier.trim(),
          'password': password,
          'device': {'platform': _platform()},
        },
      );
      await _api.tokens.write(
        Tokens(
          accessToken: json['accessToken']! as String,
          refreshToken: json['refreshToken']! as String,
        ),
      );
      _session++;
      return _user = CurrentUser.fromJson(
        (json['user']! as Map).cast<String, Object?>(),
      );
    } on ApiException catch (error) {
      throw AuthException(error.code, error.message);
    }
  }

  @override
  Future<void> signOut() async {
    try {
      await _api.post('/auth/logout');
    } on ApiException {
      // Signing out locally must work offline, and with an expired session.
    } finally {
      await _api.tokens.clear();
      _session++;
      _user = null;
    }
  }

  /// Who is signed in: nobody without tokens, whatever was known before — a
  /// refresh the server refused clears them, and the session is over.
  @override
  Future<CurrentUser?> currentUser() async {
    if (await _api.tokens.read() == null) return _user = null;
    if (_user != null) return _user;
    final startedAt = _session;
    try {
      final user = CurrentUser.fromJson(await _api.get('/auth/me'));
      // A sign-in or sign-out landed while `/auth/me` was in flight: that
      // newer state wins — this restoration is stale, so do not apply it.
      if (_session != startedAt) return _user;
      return _user = user;
    } on ApiException catch (error) {
      if (error.isUnauthenticated) return null;
      throw AuthException(error.code, error.message);
    }
  }

  @override
  Future<List<DeviceSession>> sessions() async {
    try {
      final json = await _api.get('/auth/sessions');
      return [
        for (final item in json['items']! as List<Object?>)
          DeviceSession.fromJson((item! as Map).cast<String, Object?>()),
      ];
    } on ApiException catch (error) {
      throw AuthException(error.code, error.message);
    }
  }

  @override
  Future<void> endSession(String sessionId) async {
    try {
      await _api.delete('/auth/sessions/${Uri.encodeComponent(sessionId)}');
    } on ApiException catch (error) {
      throw AuthException(error.code, error.message);
    }
  }

  @override
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    try {
      // 204 No Content; the server ends every OTHER session but keeps this one,
      // so the tokens on this device stay valid — nothing to rewrite here.
      await _api.post(
        '/auth/password',
        body: {'currentPassword': currentPassword, 'newPassword': newPassword},
      );
    } on ApiException catch (error) {
      throw AuthException(error.code, error.message);
    }
  }

  static String _platform() {
    if (kIsWeb) return 'web';
    return switch (defaultTargetPlatform) {
      TargetPlatform.iOS => 'ios',
      TargetPlatform.android => 'android',
      _ => 'unknown',
    };
  }
}
