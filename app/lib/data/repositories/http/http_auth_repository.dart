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
      _user = null;
    }
  }

  @override
  Future<CurrentUser?> currentUser() async {
    if (_user != null) return _user;
    if (await _api.tokens.read() == null) return null;
    try {
      return _user = CurrentUser.fromJson(await _api.get('/auth/me'));
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

  static String _platform() {
    if (kIsWeb) return 'web';
    return switch (defaultTargetPlatform) {
      TargetPlatform.iOS => 'ios',
      TargetPlatform.android => 'android',
      _ => 'unknown',
    };
  }
}
