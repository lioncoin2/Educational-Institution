import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/admin.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/models/people.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/auth/sign_in_prompt.dart';
import 'package:quran_institution_app/features/student/student_copy.dart';
import 'package:quran_institution_app/features/student/student_workspace_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// When a session ends on a screen — or a screen is opened by its address
/// with nobody signed in — the server answers `identity.authentication_required`.
/// A retry cannot answer that; the screen offers the sign-in instead, and
/// shows nothing it was not given. A real failure keeps its retry.
const _signedOut = 'identity.authentication_required';

class _FakeAcademic implements AcademicRepository {
  _FakeAcademic(this.error);

  final Object error;
  int reads = 0;

  @override
  Future<MyAcademic> me() async {
    reads++;
    throw error;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

Future<_FakeAcademic> _workspace(WidgetTester tester, Object error) async {
  final academic = _FakeAcademic(error);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        backendModeProvider.overrideWithValue(true),
        academicRepositoryProvider.overrideWithValue(academic),
      ],
      child: const MaterialApp(home: StudentWorkspaceScreen()),
    ),
  );
  await tester.pumpAndSettle();
  return academic;
}

void main() {
  test(
    'recognises "nobody is signed in" from every feature that reports it',
    () {
      for (final error in <Object>[
        const AcademicException(_signedOut, 'x'),
        const AdminException(_signedOut, 'x'),
        const AttendanceException(_signedOut, 'x'),
        const NotificationsException(_signedOut, 'x'),
        const PeopleException(_signedOut, 'x'),
        const AuthException(_signedOut, 'x'),
      ]) {
        expect(SignInPrompt.needsSignIn(error), isTrue, reason: '$error');
        expect(SignInPrompt.forError(error), isA<SignInPrompt>());
      }
      for (final error in <Object>[
        const AcademicException('network.unreachable', 'x'),
        const AdminException('identity.permission_denied', 'x'),
        const AuthException('identity.refresh_token_invalid', 'x'),
        StateError('boom'),
      ]) {
        expect(SignInPrompt.needsSignIn(error), isFalse, reason: '$error');
        expect(SignInPrompt.forError(error), isNull);
      }
    },
  );

  testWidgets('a screen whose session ended offers the sign-in, not a retry '
      'that cannot succeed', (tester) async {
    await _workspace(tester, const AcademicException(_signedOut, 'x'));

    expect(find.text('تسجيل الدخول'), findsOneWidget);
    expect(find.text(StudentCopy.workspaceFailed(_signedOut)), findsNothing);
  });

  testWidgets('a real failure keeps its message and retry', (tester) async {
    final academic = await _workspace(
      tester,
      const AcademicException('network.unreachable', 'x'),
    );

    expect(find.text('تسجيل الدخول'), findsNothing);
    expect(
      find.text(StudentCopy.workspaceFailed('network.unreachable')),
      findsOneWidget,
    );
    final before = academic.reads;
    await tester.tap(find.widgetWithText(OutlinedButton, StudentCopy.refresh));
    await tester.pumpAndSettle();
    expect(academic.reads, greaterThan(before));
  });

  testWidgets('signed out against the backend, «حسابي» shows no failure — only '
      'the way to sign in', (tester) async {
    await openApp(
      tester,
      Routes.profile,
      overrides: backendOverrides(CommunityServer({}), signedIn: false),
    );

    expect(find.text('تعذّر عرض المحتوى'), findsNothing);
    expect(find.text('تسجيل الدخول'), findsWidgets);
  });

  testWidgets(
    'the prompt opens the sign-in and, when it closes, has the screen '
    'read again',
    (tester) async {
      var readAgain = 0;
      final router = GoRouter(
        routes: [
          GoRoute(
            path: '/',
            builder: (context, state) =>
                Scaffold(body: SignInPrompt(onReturn: () => readAgain++)),
          ),
          GoRoute(
            path: Routes.signIn,
            builder: (context, state) => Scaffold(
              body: TextButton(
                onPressed: () => context.pop(),
                child: const Text('done'),
              ),
            ),
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();

      await tester.tap(find.text('تسجيل الدخول'));
      await tester.pumpAndSettle();
      expect(find.text('done'), findsOneWidget);
      expect(readAgain, 0);

      await tester.tap(find.text('done'));
      await tester.pumpAndSettle();
      expect(readAgain, 1);
    },
  );
}
