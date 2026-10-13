import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/admin.dart';
import 'package:quran_institution_app/data/models/auth.dart' show AccountStatus;
import 'package:quran_institution_app/data/repositories/mock/mock_admin_repository.dart';

/// The demo directory is stateful, so its lifecycle methods mutate the record
/// while keeping the server's reachable rules: unknown roles, invalid
/// transitions, too-short passwords and missing accounts refuse with the
/// server's codes; no credential is stored and the demo holds no sessions.
void main() {
  late MockAdminRepository repo;

  setUp(
    () => repo = MockAdminRepository(
      latency: Duration.zero,
      clock: () => DateTime.utc(2026, 10),
    ),
  );

  Matcher throwsCode(String code) =>
      throwsA(isA<AdminException>().having((e) => e.code, 'code', code));

  Future<AdminAccount> freshPending() => repo.createAccount(
    displayName: 'حساب جديد',
    identifier: 'new@example.edu',
    initialPassword: 'password123',
  );

  test('a created account is PENDING with no roles, then reads back', () async {
    final created = await freshPending();
    expect(created.status, AccountStatus.pending);
    expect(created.roles, isEmpty);
    expect((await repo.account(created.id)).id, created.id);
  });

  test('assigns and removes roles; unknown roles are refused', () async {
    final a = await freshPending();
    final withRole = await repo.assignRole(a.id, role: 'TEACHER');
    expect(withRole.roles, ['TEACHER']);
    // Idempotent: assigning the same role again does not duplicate it.
    expect((await repo.assignRole(a.id, role: 'TEACHER')).roles, ['TEACHER']);
    expect((await repo.removeRole(a.id, role: 'TEACHER')).roles, isEmpty);
    await expectLater(
      repo.assignRole(a.id, role: 'NOT_A_ROLE'),
      throwsCode('identity.role_unknown'),
    );
  });

  test('honours allowed status transitions and refuses the rest', () async {
    final a = await freshPending();
    expect(
      (await repo.setStatus(a.id, status: AccountStatus.active)).status,
      AccountStatus.active,
    );
    expect(
      (await repo.setStatus(a.id, status: AccountStatus.suspended)).status,
      AccountStatus.suspended,
    );
    // Nothing transitions back into PENDING.
    await expectLater(
      repo.setStatus(a.id, status: AccountStatus.pending),
      throwsCode('identity.status_transition_invalid'),
    );
  });

  test('password reset validates length and stores nothing', () async {
    final a = await freshPending();
    await expectLater(
      repo.resetPassword(a.id, newPassword: 'short'),
      throwsCode('identity.password_too_short'),
    );
    // A long-enough password is accepted and returns nothing.
    await repo.resetPassword(a.id, newPassword: 'a-strong-secret');
  });

  test('session revocation reports none, and missing accounts 404', () async {
    final a = await freshPending();
    expect(await repo.revokeSessions(a.id), 0);
    await expectLater(
      repo.account('nope'),
      throwsCode('identity.user_not_found'),
    );
    await expectLater(
      repo.assignRole('nope', role: 'TEACHER'),
      throwsCode('identity.user_not_found'),
    );
  });
}
