import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/admin.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/auth/sign_in_prompt.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// The session ended while a screen was open (or the screen was opened by its
/// address): every call the screen makes is refused with
/// `identity.authentication_required`. Each screen must offer the sign-in —
/// not a retry that can only be refused again — for the five screens whose
/// error views were wired to [SignInPrompt]: the teacher workspace, the
/// account directory, the academic structure, the notification settings and
/// the device sessions.
const _signedOut = 'identity.authentication_required';

/// The device still believes someone is signed in; the server does not.
CurrentUser _believed(Set<String> permissions) => CurrentUser(
  id: 'me',
  displayName: 'مستخدم',
  status: AccountStatus.active,
  roles: const [],
  permissions: permissions,
);

/// Every call refused as "nobody is signed in", in the repository's own type.
class _RefusingAcademic implements AcademicRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      Future<Never>.error(const AcademicException(_signedOut, 'signed out'));
}

class _RefusingAdmin implements AdminRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      Future<Never>.error(const AdminException(_signedOut, 'signed out'));
}

class _RefusingNotifications implements NotificationsRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) => Future<Never>.error(
    const NotificationsException(_signedOut, 'signed out'),
  );
}

class _RefusingAuth implements AuthRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      Future<Never>.error(const AuthException(_signedOut, 'signed out'));
}

void main() {
  final cases = <(String, String, Set<String>)>[
    ('the teacher workspace', Routes.teacherWorkspace, {'academic.teach'}),
    ('the account directory', Routes.adminAccounts, {'users.read'}),
    (
      'the academic structure screen',
      Routes.academicStructure,
      {'academic.manage'},
    ),
    ('the notification settings screen', Routes.notificationSettings, {}),
    ('the device sessions screen', Routes.sessions, {}),
  ];

  for (final (screen, route, permissions) in cases) {
    testWidgets('$screen offers the sign-in when the session has ended', (
      tester,
    ) async {
      await openApp(
        tester,
        route,
        overrides: [
          sessionUserProvider.overrideWith(
            (ref) async => _believed(permissions),
          ),
          academicRepositoryProvider.overrideWithValue(_RefusingAcademic()),
          adminRepositoryProvider.overrideWithValue(_RefusingAdmin()),
          notificationsRepositoryProvider.overrideWithValue(
            _RefusingNotifications(),
          ),
          authRepositoryProvider.overrideWithValue(_RefusingAuth()),
        ],
      );

      expect(find.byType(SignInPrompt), findsOneWidget, reason: screen);
      expect(find.text('تسجيل الدخول'), findsOneWidget, reason: screen);
    });
  }
}
