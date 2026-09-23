import '../../../app/app_config.dart';
import '../../models/auth.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// In-memory stand-in for the authentication backend.
///
/// It accepts any non-empty identifier and password: it holds no credential,
/// and must not — a password written into client code is exactly what the
/// backend forbids. What it does reproduce is the contract's behaviour, so
/// screens built against it behave the same when the real repository arrives:
/// sign-in yields a user, sign-out forgets it, sessions can be listed and ended.
class MockAuthRepository implements AuthRepository {
  MockAuthRepository();

  CurrentUser? _user;
  final List<DeviceSession> _sessions = [];
  int _nextSession = 0;

  static const _student = CurrentUser(
    id: 'mock-student',
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: ['STUDENT'],
    permissions: {
      'academic.read',
      'live.join',
      'live.raise_hand',
      'messaging.read',
      'messaging.send',
    },
    origin: DataOrigin.mock,
  );

  @override
  Future<CurrentUser> signIn({
    required String identifier,
    required String password,
  }) async {
    await Future<void>.delayed(AppConfig.fakeLatency);
    if (identifier.trim().isEmpty || password.isEmpty) {
      throw const AuthException(
        'identity.invalid_credentials',
        'The identifier or password is incorrect.',
      );
    }
    for (var i = 0; i < _sessions.length; i++) {
      final s = _sessions[i];
      _sessions[i] = DeviceSession(
        id: s.id,
        platform: s.platform,
        label: s.label,
        lastUsedAt: s.lastUsedAt,
        current: false,
      );
    }
    _sessions.add(
      DeviceSession(
        id: 'mock-session-${_nextSession++}',
        platform: 'unknown',
        label: 'This device',
        lastUsedAt: DateTime.now(),
        current: true,
      ),
    );
    return _user = _student;
  }

  @override
  Future<void> signOut() async {
    _sessions.removeWhere((session) => session.current);
    _user = null;
  }

  @override
  Future<CurrentUser?> currentUser() async => _user;

  @override
  Future<List<DeviceSession>> sessions() async {
    if (_user == null) {
      throw const AuthException(
        'identity.authentication_required',
        'Authentication required.',
      );
    }
    return List.unmodifiable(_sessions);
  }

  @override
  Future<void> endSession(String sessionId) async {
    final index = _sessions.indexWhere((session) => session.id == sessionId);
    // Like the server: another person's or a missing session is "not found".
    if (_user == null || index < 0) {
      throw const AuthException(
        'identity.session_not_found',
        'No such session.',
      );
    }
    if (_sessions.removeAt(index).current) {
      _user = null;
    }
  }
}
