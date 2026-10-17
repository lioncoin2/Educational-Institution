import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/profile/widgets/account_section.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The account/session surface on the profile. It appears only in backend mode,
/// offers sign-in when nobody is signed in, and signs out through the auth
/// repository (the one owner of that behaviour) and refreshes the session — the
/// mirror of the sign-in screen. It invents no authority of its own.
class _FakeAuth implements AuthRepository {
  _FakeAuth({this.signedOut = false});

  bool signedOut;
  int signOutCalls = 0;

  @override
  Future<void> signOut() async {
    signOutCalls++;
    signedOut = true;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

CurrentUser _user() => CurrentUser(
  id: 'u1',
  displayName: 'الأستاذ عمر',
  status: AccountStatus.active,
  roles: const ['TEACHER'],
  permissions: const {},
);

Future<void> _pump(
  WidgetTester tester, {
  required bool backend,
  required _FakeAuth auth,
}) {
  return tester.pumpWidget(
    ProviderScope(
      overrides: [
        backendModeProvider.overrideWithValue(backend),
        authRepositoryProvider.overrideWithValue(auth),
        sessionUserProvider.overrideWith(
          (ref) async => auth.signedOut ? null : _user(),
        ),
      ],
      child: const MaterialApp(home: Scaffold(body: AccountSection())),
    ),
  );
}

void main() {
  testWidgets('is absent in demo mode — there is no server session to manage', (
    tester,
  ) async {
    await _pump(tester, backend: false, auth: _FakeAuth());
    await tester.pumpAndSettle();
    expect(find.byType(ListTile), findsNothing);
    expect(find.text('تسجيل الدخول'), findsNothing);
    expect(find.text('تسجيل الخروج'), findsNothing);
  });

  testWidgets('offers sign-in when nobody is signed in (backend mode)', (
    tester,
  ) async {
    await _pump(tester, backend: true, auth: _FakeAuth(signedOut: true));
    await tester.pumpAndSettle();
    expect(find.text('تسجيل الدخول'), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'تسجيل الخروج'), findsNothing);
  });

  testWidgets(
    'shows the signed-in account and signs out through the repository',
    (tester) async {
      final auth = _FakeAuth();
      await _pump(tester, backend: true, auth: auth);
      await tester.pumpAndSettle();

      expect(find.text('الأستاذ عمر'), findsOneWidget);
      final signOut = find.widgetWithText(TextButton, 'تسجيل الخروج');
      expect(signOut, findsOneWidget);

      await tester.tap(signOut);
      await tester.pumpAndSettle();
      // Confirm in the dialog.
      await tester.tap(find.widgetWithText(FilledButton, 'تسجيل الخروج'));
      await tester.pumpAndSettle();

      expect(auth.signOutCalls, 1);
      // The session was refreshed: the view now reflects a signed-out device.
      expect(find.text('تسجيل الدخول'), findsOneWidget);
      expect(find.text('الأستاذ عمر'), findsNothing);
    },
  );
}
