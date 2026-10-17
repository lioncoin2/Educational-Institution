import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/profile/change_password_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The self-service password change. The server is the authority; this screen
/// only gathers the three fields, mirrors the cheap checks, calls
/// [AuthRepository.changePassword] once, and maps the server's refusal code to
/// a message. These tests pin that contract: no request on a client-side shape
/// error, exactly one request with the typed values on success, and the right
/// message for a server refusal.
class _FakeAuth implements AuthRepository {
  _FakeAuth({this.error});

  final AuthException? error;
  int calls = 0;
  String? sentCurrent;
  String? sentNew;

  @override
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    calls++;
    sentCurrent = currentPassword;
    sentNew = newPassword;
    if (error != null) throw error!;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

Future<void> _pump(WidgetTester tester, _FakeAuth auth) async {
  final router = GoRouter(
    initialLocation: '/profile/password',
    routes: [
      GoRoute(
        path: '/profile',
        builder: (context, state) =>
            const Scaffold(body: Center(child: Text('PROFILE-HOME'))),
        routes: [
          GoRoute(
            path: 'password',
            builder: (context, state) => const ChangePasswordScreen(),
          ),
        ],
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(auth)],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _fill(
  WidgetTester tester, {
  required String current,
  required String next,
  required String confirm,
}) async {
  await tester.enterText(
    find.widgetWithText(TextFormField, 'كلمة المرور الحالية'),
    current,
  );
  await tester.enterText(
    find.widgetWithText(TextFormField, 'كلمة المرور الجديدة'),
    next,
  );
  await tester.enterText(
    find.widgetWithText(TextFormField, 'تأكيد كلمة المرور الجديدة'),
    confirm,
  );
}

Finder get _save => find.widgetWithText(FilledButton, 'حفظ كلمة المرور');

void main() {
  testWidgets('a mismatched confirmation is refused before any request', (
    tester,
  ) async {
    final auth = _FakeAuth();
    await _pump(tester, auth);
    await _fill(tester, current: 'old-secret', next: 'brand-new-1', confirm: 'different');
    await tester.tap(_save);
    await tester.pumpAndSettle();

    expect(find.text('لا يطابق كلمة المرور الجديدة.'), findsOneWidget);
    expect(auth.calls, 0);
  });

  testWidgets('a too-short new password is refused before any request', (
    tester,
  ) async {
    final auth = _FakeAuth();
    await _pump(tester, auth);
    await _fill(tester, current: 'old-secret', next: 'short', confirm: 'short');
    await tester.tap(_save);
    await tester.pumpAndSettle();

    expect(find.text('8 أحرف على الأقل.'), findsOneWidget);
    expect(auth.calls, 0);
  });

  testWidgets('a valid form calls the repository once and returns', (
    tester,
  ) async {
    final auth = _FakeAuth();
    await _pump(tester, auth);
    await _fill(
      tester,
      current: 'old-secret',
      next: 'brand-new-1',
      confirm: 'brand-new-1',
    );
    await tester.tap(_save);
    await tester.pumpAndSettle();

    expect(auth.calls, 1);
    expect(auth.sentCurrent, 'old-secret');
    expect(auth.sentNew, 'brand-new-1');
    // Success: a confirmation is shown and the screen pops back.
    expect(
      find.text('تم تغيير كلمة المرور. سُجّل خروج جلساتك على الأجهزة الأخرى.'),
      findsOneWidget,
    );
    expect(find.text('PROFILE-HOME'), findsOneWidget);
  });

  testWidgets('a wrong current password maps to the server message', (
    tester,
  ) async {
    final auth = _FakeAuth(
      error: const AuthException(
        'identity.current_password_incorrect',
        'The current password is incorrect.',
      ),
    );
    await _pump(tester, auth);
    await _fill(
      tester,
      current: 'wrong',
      next: 'brand-new-1',
      confirm: 'brand-new-1',
    );
    await tester.tap(_save);
    await tester.pumpAndSettle();

    expect(auth.calls, 1);
    expect(find.text('كلمة المرور الحالية غير صحيحة.'), findsOneWidget);
    // Still on the screen (no pop on failure).
    expect(find.text('PROFILE-HOME'), findsNothing);
  });
}
