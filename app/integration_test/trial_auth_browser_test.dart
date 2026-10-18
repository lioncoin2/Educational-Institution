import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:quran_institution_app/main.dart' as app;

/// Real-browser verification of the authentication journey through the actual
/// CanvasKit UI, driven by Flutter's integration_test via `flutter drive` on a
/// Chrome web device, against the live trial backend. Owner credentials are
/// supplied as --dart-define at run time (never committed). It records a
/// per-step progress trail into the binding's reportData so the driver can
/// write it out — `flutter drive` on web does not surface failure messages.
const _owner = String.fromEnvironment('ownerEmail');
const _ownerPw = String.fromEnvironment('ownerPassword');

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('loads, signs in, and signs out through the real browser UI', (tester) async {
    final steps = <String>[];

    Future<bool> reach(String name, Finder f, {Duration t = const Duration(seconds: 25)}) async {
      final deadline = DateTime.now().add(t);
      while (DateTime.now().isBefore(deadline)) {
        await tester.pump(const Duration(milliseconds: 200));
        if (f.evaluate().isNotEmpty) {
          steps.add('OK $name');
          return true;
        }
      }
      steps.add('TIMEOUT $name');
      return false;
    }

    try {
      app.main();
      steps.add('app.main() returned; creds ${_owner.length}/${_ownerPw.length}');
      if (await reach('nav-shell', find.byIcon(Icons.person_outline_rounded))) {
        await tester.tap(find.byIcon(Icons.person_outline_rounded).first);
        if (await reach('signin-entry', find.text('تسجيل الدخول'))) {
          await tester.tap(find.text('تسجيل الدخول').first);
          if (await reach('signin-fields', find.byType(TextField))) {
            final f = find.byType(TextField);
            // tester.enterText is a no-op in Flutter WEB integration tests, so set
            // the fields through their own controllers — the real submit button,
            // the real signIn() call and the real session logic still run unchanged.
            tester.widget<TextField>(f.at(0)).controller?.text = _owner;
            tester.widget<TextField>(f.at(1)).controller?.text = _ownerPw;
            await tester.pump();
            steps.add('set-controllers: f0=${tester.widget<TextField>(f.at(0)).controller?.text.length ?? -1} '
                'f1=${tester.widget<TextField>(f.at(1)).controller?.text.length ?? -1}');
            await tester.tap(find.text('دخول'));
            // Let the cross-origin round-trip + token write + pop + /auth/me settle.
            for (var k = 0; k < 60; k++) {
              await tester.pump(const Duration(milliseconds: 500));
              if (find.text('تسجيل الخروج').evaluate().isNotEmpty) break;
            }
            steps.add('after-submit: signout=${find.text('تسجيل الخروج').evaluate().length} '
                'stillSigninBtn=${find.text('دخول').evaluate().length} '
                'signinEntry=${find.text('تسجيل الدخول').evaluate().length}');
            for (final m in const [
              'تعذّر تسجيل الدخول', 'غير صحيحة', 'موقوف', 'معطّل', 'لم يُفعّل',
              'محاولات كثيرة', 'تعذّر الاتصال بالخادم', 'الخدمة غير متاحة',
            ]) {
              if (find.textContaining(m).evaluate().isNotEmpty) steps.add('error-shown: $m');
            }
            if (await reach('signed-in', find.text('تسجيل الخروج'), t: const Duration(seconds: 5))) {
              await tester.tap(find.text('تسجيل الخروج').first);
              if (await reach('confirm-dialog', find.widgetWithText(FilledButton, 'تسجيل الخروج'))) {
                await tester.tap(find.widgetWithText(FilledButton, 'تسجيل الخروج'));
                await reach('signed-out', find.text('تسجيل الدخول'));
              }
            }
          }
        }
      }
    } catch (e) {
      steps.add('EXCEPTION ${e.toString().split('\n').first}');
    }

    binding.reportData = {'steps': steps};
    // The recorded trail is the evidence (flutter-drive-web does not propagate
    // assertion messages); these assertions make it a real regression test.
    final trail = steps.join(' | ');
    expect(steps, contains('OK signed-in'), reason: trail);
    expect(steps, contains('OK signed-out'), reason: trail);
    expect(steps.where((s) => s.startsWith('error-shown')), isEmpty, reason: trail);
  });
}
