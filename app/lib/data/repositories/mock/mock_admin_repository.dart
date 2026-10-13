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
