import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/admin.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/admin/admin_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// Admin account provisioning: the directory lists accounts for a holder of
/// users.read; creating one is offered only to a holder of users.manage; the
/// server re-authorises every call. The fake here stands in for the server.
class _FakeAdmin implements AdminRepository {
  _FakeAdmin({List<AdminAccount> seed = const [], this.failCreateWith})
    : _accounts = [...seed];

  /// When set, every create is refused with this code.
  final String? failCreateWith;
  final List<AdminAccount> _accounts;
  final List<String> created = [];

  @override
  Future<AdminAccountPage> accounts({String? cursor}) async =>
      AdminAccountPage(items: [..._accounts], nextCursor: null);

  @override
  Future<AdminAccount> createAccount({
    required String displayName,
    required String identifier,
    required String initialPassword,
  }) async {
    created.add(identifier);
    final code = failCreateWith;
    if (code != null) throw AdminException(code, code);
    final account = AdminAccount(
      id: 'new-$identifier',
      displayName: displayName,
      status: AccountStatus.pending,
      identifiers: [AccountIdentifier(type: 'email', value: identifier)],
      roles: const [],
      createdAt: DateTime.utc(2026, 10),
      origin: DataOrigin.records,
    );
    _accounts.insert(0, account);
    return account;
  }
}

AdminAccount _account(String name, String email) => AdminAccount(
  id: email,
  displayName: name,
  status: AccountStatus.active,
  identifiers: [AccountIdentifier(type: 'email', value: email)],
  roles: const ['TEACHER'],
  createdAt: DateTime.utc(2026),
  origin: DataOrigin.records,
);

CurrentUser _user(Set<String> permissions) => CurrentUser(
  id: 'me',
  displayName: 'مسؤول',
  status: AccountStatus.active,
  roles: const [],
  permissions: permissions,
);

void main() {
  final fab = find.byKey(const Key('admin-create-account-fab'));

  List<Override> overrides(AdminRepository repo, CurrentUser user) => [
    adminRepositoryProvider.overrideWithValue(repo),
    sessionUserProvider.overrideWith((ref) async => user),
  ];

  testWidgets('lists the institution accounts', (tester) async {
    final repo = _FakeAdmin(
      seed: [_account('الأستاذة مريم', 'maryam@example.edu')],
    );
    await openApp(
      tester,
      '/admin/accounts',
      overrides: overrides(repo, _user({'users.read', 'users.manage'})),
    );
    expect(find.text('الأستاذة مريم'), findsOneWidget);
    expect(find.text('maryam@example.edu'), findsOneWidget);
  });

  testWidgets('shows the create button to a holder of users.manage', (
    tester,
  ) async {
    await openApp(
      tester,
      '/admin/accounts',
      overrides: overrides(_FakeAdmin(), _user({'users.read', 'users.manage'})),
    );
    expect(fab, findsOneWidget);
  });

  testWidgets('hides the create button from a read-only viewer', (
    tester,
  ) async {
    await openApp(
      tester,
      '/admin/accounts',
      overrides: overrides(_FakeAdmin(), _user({'users.read'})),
    );
    expect(fab, findsNothing);
  });

  testWidgets(
    'creates an account — the server is asked, it appears, the sheet closes',
    (tester) async {
      final repo = _FakeAdmin();
      await openApp(
        tester,
        '/admin/accounts',
        overrides: overrides(repo, _user({'users.read', 'users.manage'})),
      );
      await tester.tap(fab);
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('admin-account-name')),
        'حساب جديد',
      );
      await tester.enterText(
        find.byKey(const Key('admin-account-email')),
        'new@example.edu',
      );
      await tester.enterText(
        find.byKey(const Key('admin-account-password')),
        'password123',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('admin-account-submit')));
      await tester.pumpAndSettle();

      expect(repo.created, ['new@example.edu']);
      expect(find.text(AdminCopy.accountCreated), findsOneWidget);
      // The sheet closed, and the new account is in the refreshed list.
      expect(find.byKey(const Key('admin-account-name')), findsNothing);
      expect(find.text('حساب جديد'), findsOneWidget);
    },
  );

  testWidgets('a refused create is said in words, and the sheet stays open', (
    tester,
  ) async {
    final repo = _FakeAdmin(failCreateWith: 'identity.identifier_taken');
    await openApp(
      tester,
      '/admin/accounts',
      overrides: overrides(repo, _user({'users.read', 'users.manage'})),
    );
    await tester.tap(fab);
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('admin-account-name')), 'حساب');
    await tester.enterText(
      find.byKey(const Key('admin-account-email')),
      'taken@example.edu',
    );
    await tester.enterText(
      find.byKey(const Key('admin-account-password')),
      'password123',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('admin-account-submit')));
    await tester.pumpAndSettle();

    expect(
      find.text(AdminCopy.createFailed('identity.identifier_taken')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('admin-account-name')), findsOneWidget);
  });
}
