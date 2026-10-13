import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/admin.dart';
import 'package:quran_institution_app/data/models/auth.dart' show AccountStatus;
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_admin_repository.dart';

/// The demo `/admin/users` store keeps the server's rules so the screens behave
/// the same against the real API.
void main() {
  MockAdminRepository repo() => MockAdminRepository(
    latency: Duration.zero,
    clock: () => DateTime.utc(2026, 10),
  );

  Matcher refusedWith(String code) =>
      throwsA(isA<AdminException>().having((e) => e.code, 'code', code));

  test('lists seeded accounts, mock-flagged, a single page', () async {
    final page = await repo().accounts();
    expect(page.items, isNotEmpty);
    expect(page.items.every((a) => a.origin == DataOrigin.mock), isTrue);
    expect(page.nextCursor, isNull);
  });

  test('creates a PENDING, role-less account that then appears', () async {
    final r = repo();
    final created = await r.createAccount(
      displayName: '  حساب جديد  ',
      identifier: 'NEW@Example.edu',
      initialPassword: 'password123',
    );
    expect(created.displayName, 'حساب جديد'); // trimmed
    expect(created.primaryIdentifier, 'new@example.edu'); // normalised
    expect(created.status, AccountStatus.pending);
    expect(created.roles, isEmpty);
    expect(created.origin, DataOrigin.mock);
    final page = await r.accounts();
    expect(page.items.any((a) => a.id == created.id), isTrue);
  });

  test('refuses a short password, a bad email, and a duplicate', () async {
    final r = repo();
    await expectLater(
      r.createAccount(
        displayName: 'x',
        identifier: 'a@b.co',
        initialPassword: 'short',
      ),
      refusedWith('identity.password_too_short'),
    );
    await expectLater(
      r.createAccount(
        displayName: 'x',
        identifier: 'notanemail',
        initialPassword: 'password123',
      ),
      refusedWith('identity.identifier_invalid'),
    );
    await r.createAccount(
      displayName: 'x',
      identifier: 'dup@example.edu',
      initialPassword: 'password123',
    );
    await expectLater(
      r.createAccount(
        displayName: 'y',
        identifier: 'dup@example.edu',
        initialPassword: 'password123',
      ),
      refusedWith('identity.identifier_taken'),
    );
  });
}
