import '../../../app/app_config.dart';
import '../../models/admin.dart';
import '../../models/auth.dart' show AccountStatus;
import '../../models/data_origin.dart';
import '../repositories.dart';

/// In-memory stand-in for `/admin/users`, for the demo build and widget tests.
///
/// It keeps the server's rules so the screens behave the same against the real
/// API: a new account is PENDING with no roles, an email is normalised and
/// must be unique and well-shaped, and a password shorter than 8 is refused
/// with the server's code. Everything it holds is invented and marked
/// [DataOrigin.mock]. In the demo the signed-in person is a student without
/// `users.read`, so this directory is never shown there; it exists for the
/// contract and for tests.
class MockAdminRepository implements AdminRepository {
  MockAdminRepository({
    this.latency = AppConfig.fakeLatency,
    DateTime Function()? clock,
  }) : clock = clock ?? DateTime.now {
    _seed();
  }

  final Duration latency;
  final DateTime Function() clock;

  final List<AdminAccount> _accounts = [];
  final Set<String> _identifiers = {};
  int _serial = 0;

  @override
  Future<AdminAccountPage> accounts({String? cursor}) async {
    await _wait();
    // The demo is a single page; a cursor is spent.
    if (cursor != null) {
      return const AdminAccountPage(items: [], nextCursor: null);
    }
    final sorted = [..._accounts]
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return AdminAccountPage(items: sorted, nextCursor: null);
  }

  @override
  Future<AdminAccount> createAccount({
    required String displayName,
    required String identifier,
    required String initialPassword,
  }) async {
    await _wait();
    final name = displayName.trim();
    final email = identifier.trim().toLowerCase();
    // Mirror the server's reachable validation, in its order.
    if (initialPassword.runes.length < 8) {
      throw const AdminException(
        'identity.password_too_short',
        'The initial password is too short.',
      );
    }
    if (!_looksLikeEmail(email)) {
      throw const AdminException(
        'identity.identifier_invalid',
        'That is not a valid email address.',
      );
    }
    if (_identifiers.contains(email)) {
      throw const AdminException(
        'identity.identifier_taken',
        'An account with this identifier already exists.',
      );
    }
    _identifiers.add(email);
    final account = AdminAccount(
      id: 'mock-account-${++_serial}',
      displayName: name,
      status: AccountStatus.pending,
      identifiers: [AccountIdentifier(type: 'email', value: email)],
      roles: const [],
      createdAt: clock(),
      origin: DataOrigin.mock,
    );
    _accounts.add(account);
    return account;
  }

  // ── Lifecycle (keeps the server's reachable rules on the in-memory record) ──
  // The demo directory is stateful, so these mutate it; self/outrank rules are
  // not modelled (the demo has one viewer), but unknown roles, invalid
  // transitions and missing accounts refuse with the server's codes. No
  // credential is stored, and the demo holds no sessions.
  static const _knownRoles = {
    'OWNER',
    'ADMIN',
    'SUPERVISOR',
    'TEACHER',
    'ASSISTANT_TEACHER',
    'STUDENT',
  };
  static const _transitions = <AccountStatus, Set<AccountStatus>>{
    AccountStatus.pending: {AccountStatus.active, AccountStatus.disabled},
    AccountStatus.active: {AccountStatus.suspended, AccountStatus.disabled},
    AccountStatus.suspended: {AccountStatus.active, AccountStatus.disabled},
    AccountStatus.disabled: {AccountStatus.active},
  };

  AdminAccount _byId(String userId) {
    for (final a in _accounts) {
      if (a.id == userId) return a;
    }
    throw const AdminException('identity.user_not_found', 'No such account.');
  }

  AdminAccount _store(AdminAccount updated) {
    final i = _accounts.indexWhere((a) => a.id == updated.id);
    if (i >= 0) _accounts[i] = updated;
    return updated;
  }

  AdminAccount _copy(
    AdminAccount a, {
    List<String>? roles,
    AccountStatus? status,
  }) => AdminAccount(
    id: a.id,
    displayName: a.displayName,
    status: status ?? a.status,
    identifiers: a.identifiers,
    roles: roles ?? a.roles,
    createdAt: a.createdAt,
    origin: a.origin,
  );

  @override
  Future<AdminAccount> account(String userId) async {
    await _wait();
    return _byId(userId);
  }

  @override
  Future<AdminAccount> assignRole(String userId, {required String role}) async {
    await _wait();
    final a = _byId(userId);
    if (!_knownRoles.contains(role)) {
      throw const AdminException('identity.role_unknown', 'Unknown role.');
    }
    if (a.roles.contains(role)) return a;
    return _store(_copy(a, roles: [...a.roles, role]));
  }

  @override
  Future<AdminAccount> removeRole(String userId, {required String role}) async {
    await _wait();
    final a = _byId(userId);
    return _store(
      _copy(
        a,
        roles: [
          for (final r in a.roles)
            if (r != role) r,
        ],
      ),
    );
  }

  @override
  Future<AdminAccount> setStatus(
    String userId, {
    required AccountStatus status,
  }) async {
    await _wait();
    final a = _byId(userId);
    final allowed = _transitions[a.status] ?? const <AccountStatus>{};
    if (!allowed.contains(status)) {
      throw const AdminException(
        'identity.status_transition_invalid',
        'That status change is not allowed.',
      );
    }
    return _store(_copy(a, status: status));
  }

  @override
  Future<void> resetPassword(
    String userId, {
    required String newPassword,
  }) async {
    await _wait();
    _byId(userId); // identity.user_not_found when missing
    if (newPassword.runes.length < 8) {
      throw const AdminException(
        'identity.password_too_short',
        'The password is too short.',
      );
    }
    // The demo keeps no credentials; nothing is stored.
  }

  @override
  Future<int> revokeSessions(String userId) async {
    await _wait();
    _byId(userId);
    return 0; // the demo holds no sessions
  }

  static bool _looksLikeEmail(String value) =>
      RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(value);

  Future<void> _wait() =>
      latency == Duration.zero ? Future.value() : Future.delayed(latency);

  void _seed() {
    final base = DateTime.utc(2026, 9, 1, 8);
    const seeds = <(String, String, AccountStatus, List<String>)>[
      ('الأستاذ عبدالله', 'owner@example.edu', AccountStatus.active, ['OWNER']),
      ('الأستاذة مريم', 'admin@example.edu', AccountStatus.active, ['ADMIN']),
      (
        'الأستاذة عائشة',
        'teacher@example.edu',
        AccountStatus.active,
        ['TEACHER'],
      ),
      (
        'طالبة تجريبية',
        'student@example.edu',
        AccountStatus.active,
        ['STUDENT'],
      ),
      ('حساب جديد', 'pending@example.edu', AccountStatus.pending, <String>[]),
    ];
    var i = 0;
    for (final (name, email, status, roles) in seeds) {
      _identifiers.add(email);
      _accounts.add(
        AdminAccount(
          id: 'mock-account-seed-$i',
          displayName: name,
          status: status,
          identifiers: [AccountIdentifier(type: 'email', value: email)],
          roles: roles,
          createdAt: base.add(Duration(days: i)),
          origin: DataOrigin.mock,
        ),
      );
      i++;
    }
  }
}
