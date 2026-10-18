import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/admin.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/admin/account_detail_copy.dart';
import 'package:quran_institution_app/features/admin/admin_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// Account-lifecycle administration: a holder of the matching capability (and
/// never on their own account) assigns/removes roles, changes status, sets a
/// password and revokes sessions; the server (the fake here) stays the
/// authority and a refusal is said in words. A read-only viewer sees no
/// controls. No credential is ever recorded by the fake.
class _FakeAdmin implements AdminRepository {
  _FakeAdmin(this._account, {this.failWith});

  AdminAccount _account;
  String? failWith;
  final List<String> writes = [];

  void _fail() {
    final code = failWith;
    if (code != null) throw AdminException(code, code);
  }

  AdminAccount _copy({List<String>? roles, AccountStatus? status}) =>
      AdminAccount(
        id: _account.id,
        displayName: _account.displayName,
        status: status ?? _account.status,
        identifiers: _account.identifiers,
        roles: roles ?? _account.roles,
        createdAt: _account.createdAt,
        origin: DataOrigin.records,
      );

  @override
  Future<AdminAccount> account(String userId) async => _account;

  @override
  Future<AdminAccount> assignRole(String userId, {required String role}) async {
    writes.add('assign $role');
    _fail();
    return _account = _copy(roles: [..._account.roles, role]);
  }

  @override
  Future<AdminAccount> removeRole(String userId, {required String role}) async {
    writes.add('remove $role');
    _fail();
    return _account = _copy(
      roles: [
        for (final r in _account.roles)
          if (r != role) r,
      ],
    );
  }

  @override
  Future<AdminAccount> setStatus(
    String userId, {
    required AccountStatus status,
  }) async {
    writes.add('status ${status.wire}');
    _fail();
    return _account = _copy(status: status);
  }

  @override
  Future<void> resetPassword(
    String userId, {
    required String newPassword,
  }) async {
    writes.add('password'); // never the credential itself
    _fail();
  }

  @override
  Future<int> revokeSessions(String userId) async {
    writes.add('revoke');
    _fail();
    return 3;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

AdminAccount _seed({
  String id = 'u:1',
  AccountStatus status = AccountStatus.active,
  List<String> roles = const ['TEACHER'],
}) => AdminAccount(
  id: id,
  displayName: 'الأستاذة مريم',
  status: status,
  identifiers: const [AccountIdentifier(type: 'email', value: 'm@example.edu')],
  roles: roles,
  createdAt: DateTime.utc(2026, 9),
  origin: DataOrigin.records,
);

CurrentUser _user(String id, Set<String> permissions) => CurrentUser(
  id: id,
  displayName: 'مسؤولة',
  status: AccountStatus.active,
  roles: const [],
  permissions: permissions,
);

const _fullAdmin = {
  'users.read',
  'users.manage',
  'roles.assign',
  'sessions.manage',
};

void main() {
  final assign = find.byKey(const Key('account-assign-role-button'));
  final changeStatus = find.byKey(const Key('account-change-status-button'));
  final resetPassword = find.byKey(const Key('account-reset-password-button'));
  final revoke = find.byKey(const Key('account-revoke-sessions-button'));

  List<Override> overrides(_FakeAdmin repo, CurrentUser user) => [
    adminRepositoryProvider.overrideWithValue(repo),
    backendModeProvider.overrideWithValue(true),
    sessionUserProvider.overrideWith((ref) async => user),
  ];

  Future<void> open(
    WidgetTester tester, {
    required _FakeAdmin repo,
    required CurrentUser user,
  }) => openApp(
    tester,
    Routes.adminAccount('u:1'),
    overrides: overrides(repo, user),
  );

  Future<void> confirm(WidgetTester tester, String label) async {
    await tester.tap(find.widgetWithText(FilledButton, label));
    await tester.pumpAndSettle();
  }

  testWidgets('shows the account, its status and roles', (tester) async {
    await open(
      tester,
      repo: _FakeAdmin(_seed()),
      user: _user('me', _fullAdmin),
    );
    expect(find.text('الأستاذة مريم'), findsWidgets);
    expect(find.text(AdminCopy.status(AccountStatus.active)), findsOneWidget);
    expect(find.text(AdminCopy.role('TEACHER')), findsOneWidget);
    expect(find.text('m@example.edu'), findsOneWidget);
  });

  testWidgets('withholds every control from a read-only viewer', (
    tester,
  ) async {
    await open(
      tester,
      repo: _FakeAdmin(_seed()),
      user: _user('me', {'users.read'}),
    );
    expect(find.text('الأستاذة مريم'), findsWidgets); // still readable
    expect(assign, findsNothing);
    expect(changeStatus, findsNothing);
    expect(resetPassword, findsNothing);
    expect(revoke, findsNothing);
    expect(find.byIcon(Icons.close), findsNothing); // roles not deletable
  });

  // The server sends `identifiers: null` to a reader without users.manage.
  testWidgets('says the login identifier is withheld from a read-only viewer', (
    tester,
  ) async {
    final withheld = AdminAccount(
      id: 'u:1',
      displayName: 'الأستاذة مريم',
      status: AccountStatus.active,
      identifiers: const [],
      identifiersWithheld: true,
      roles: const ['TEACHER'],
      createdAt: DateTime.utc(2026, 9),
      origin: DataOrigin.records,
    );
    await open(
      tester,
      repo: _FakeAdmin(withheld),
      user: _user('me', {'users.read'}),
    );
    expect(find.text(AdminCopy.identifierWithheld), findsOneWidget);
    expect(find.text(AdminCopy.noIdentifier), findsNothing);
    expect(find.text('m@example.edu'), findsNothing);
  });

  testWidgets('refuses to administer your own account', (tester) async {
    // The actor IS this account.
    await open(
      tester,
      repo: _FakeAdmin(_seed(id: 'u:1')),
      user: _user('u:1', _fullAdmin),
    );
    expect(find.text(AccountDetailCopy.selfNote), findsOneWidget);
    expect(assign, findsNothing);
    expect(changeStatus, findsNothing);
  });

  testWidgets('assigns a role after confirmation, then shows it', (
    tester,
  ) async {
    final repo = _FakeAdmin(_seed());
    await open(tester, repo: repo, user: _user('me', _fullAdmin));

    await tester.tap(assign);
    await tester.pumpAndSettle();
    await tester.tap(find.text(AdminCopy.role('SUPERVISOR')));
    await tester.pumpAndSettle();
    await confirm(tester, AccountDetailCopy.confirm);

    expect(repo.writes, contains('assign SUPERVISOR'));
    expect(find.text(AccountDetailCopy.roleAssigned), findsOneWidget);
    expect(find.text(AdminCopy.role('SUPERVISOR')), findsOneWidget);
  });

  testWidgets('removes a role after confirmation', (tester) async {
    final repo = _FakeAdmin(_seed());
    await open(tester, repo: repo, user: _user('me', _fullAdmin));

    await tester.tap(find.byIcon(Icons.close)); // the TEACHER chip's delete
    await tester.pumpAndSettle();
    await confirm(tester, AccountDetailCopy.confirm);

    expect(repo.writes, contains('remove TEACHER'));
    expect(find.text(AccountDetailCopy.roleRemoved), findsOneWidget);
  });

  testWidgets('changes status after explaining the effect', (tester) async {
    final repo = _FakeAdmin(_seed());
    await open(tester, repo: repo, user: _user('me', _fullAdmin));

    await tester.tap(changeStatus);
    await tester.pumpAndSettle();
    await tester.tap(find.text(AdminCopy.status(AccountStatus.suspended)));
    await tester.pumpAndSettle();
    await confirm(tester, AccountDetailCopy.confirm);

    expect(repo.writes, contains('status SUSPENDED'));
    expect(find.text(AccountDetailCopy.statusChanged), findsOneWidget);
    expect(
      find.text(AdminCopy.status(AccountStatus.suspended)),
      findsOneWidget,
    );
  });

  testWidgets('sets a new password; a mismatch is caught without a request', (
    tester,
  ) async {
    final repo = _FakeAdmin(_seed());
    await open(tester, repo: repo, user: _user('me', _fullAdmin));

    await tester.tap(resetPassword);
    await tester.pumpAndSettle();
    // Mismatch first — no request is made.
    await tester.enterText(
      find.byKey(const Key('account-password-new')),
      'password123',
    );
    await tester.enterText(
      find.byKey(const Key('account-password-confirm')),
      'different999',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('account-password-submit')));
    await tester.pumpAndSettle();
    expect(find.text(AccountDetailCopy.passwordMismatch), findsOneWidget);
    expect(repo.writes, isEmpty);

    // Correct it and submit.
    await tester.enterText(
      find.byKey(const Key('account-password-confirm')),
      'password123',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('account-password-submit')));
    await tester.pumpAndSettle();
    expect(repo.writes, contains('password'));
    expect(find.text(AccountDetailCopy.passwordUpdated), findsOneWidget);
  });

  testWidgets('revokes sessions after confirmation and reports the count', (
    tester,
  ) async {
    final repo = _FakeAdmin(_seed());
    await open(tester, repo: repo, user: _user('me', _fullAdmin));

    await tester.tap(revoke);
    await tester.pumpAndSettle();
    await confirm(tester, AccountDetailCopy.confirmRevoke);

    expect(repo.writes, contains('revoke'));
    expect(find.text(AccountDetailCopy.sessionsEnded(3)), findsOneWidget);
  });

  testWidgets('a refused role change is said in words, and nothing changes', (
    tester,
  ) async {
    final repo = _FakeAdmin(_seed(), failWith: 'identity.role_outranks_actor');
    await open(tester, repo: repo, user: _user('me', _fullAdmin));

    await tester.tap(assign);
    await tester.pumpAndSettle();
    await tester.tap(find.text(AdminCopy.role('ADMIN')));
    await tester.pumpAndSettle();
    await confirm(tester, AccountDetailCopy.confirm);

    expect(
      find.text(AccountDetailCopy.actionFailed('identity.role_outranks_actor')),
      findsOneWidget,
    );
    expect(find.text(AdminCopy.role('ADMIN')), findsNothing); // not added
  });
}
