import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:quran_institution_app/features/messaging/widgets/conversation_tile.dart';
import 'package:quran_institution_app/main.dart' as app;

/// Real-browser verification of the remaining trial workflows — academic roster,
/// messaging read/send, attachment display, and realtime delivery — driven
/// through the actual CanvasKit UI via `flutter drive` on Chrome, against the
/// live backend + an isolated trial database. Credentials and the seeded direct
/// conversation id are supplied as --dart-define at run time (never committed).
/// A per-step trail is recorded into reportData because flutter-drive-web does
/// not surface assertion messages.
const _api = String.fromEnvironment('API_BASE_URL');
const _teacherEmail = String.fromEnvironment('teacherEmail');
const _teacherPw = String.fromEnvironment('teacherPassword');
const _studentEmail = String.fromEnvironment('studentEmail');
const _studentPw = String.fromEnvironment('studentPassword');
const _dm = String.fromEnvironment('dmConversationId');

// Values seeded by scripts (seed.sh) — fixed, so asserted directly.
const _halaqaName = 'حلقة الواجهة';
const _studentName = 'طالب الواجهة';
const _seededText = 'سلام من المعلّم';
const _imageCaption = 'لوح';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final steps = <String>[];

  Future<bool> reach(WidgetTester t, String name, Finder f,
      {Duration to = const Duration(seconds: 30)}) async {
    final end = DateTime.now().add(to);
    while (DateTime.now().isBefore(end)) {
      await t.pump(const Duration(milliseconds: 200));
      if (f.evaluate().isNotEmpty) {
        steps.add('OK $name');
        return true;
      }
    }
    steps.add('TIMEOUT $name');
    return false;
  }

  Future<void> tapText(WidgetTester t, String s) async {
    final f = find.text(s);
    // Let an in-flight rebuild settle, then scroll the lazy CustomScrollView
    // until the (possibly off-screen, not-yet-built) row materializes.
    for (var i = 0; i < 10 && f.evaluate().isEmpty; i++) {
      await t.pump(const Duration(milliseconds: 200));
    }
    if (f.evaluate().isEmpty) {
      final scrollable = find.byType(Scrollable);
      if (scrollable.evaluate().isNotEmpty) {
        await t.scrollUntilVisible(f, 250, scrollable: scrollable.first, maxScrolls: 40);
      }
    }
    await t.ensureVisible(f.first);
    await t.pump(const Duration(milliseconds: 200));
    await t.tap(f.first);
    await t.pump(const Duration(milliseconds: 400));
  }

  Future<void> gotoProfile(WidgetTester t) async {
    await t.tap(find.byIcon(Icons.person_outline_rounded).first);
    await t.pump(const Duration(milliseconds: 400));
  }

  Future<void> ensureSignedOut(WidgetTester t) async {
    await gotoProfile(t);
    await t.pump(const Duration(seconds: 1));
    if (find.text('تسجيل الخروج').evaluate().isNotEmpty) {
      await tapText(t, 'تسجيل الخروج');
      await reach(t, 'confirm-out', find.widgetWithText(FilledButton, 'تسجيل الخروج'));
      await t.tap(find.widgetWithText(FilledButton, 'تسجيل الخروج'));
      await reach(t, 'is-signed-out', find.text('تسجيل الدخول'));
    }
  }

  Future<void> signIn(WidgetTester t, String email, String pw) async {
    await reach(t, 'signin-entry', find.text('تسجيل الدخول'));
    await tapText(t, 'تسجيل الدخول');
    await reach(t, 'signin-fields', find.byType(TextField));
    final f = find.byType(TextField);
    t.widget<TextField>(f.at(0)).controller?.text = email; // enterText is a no-op on web
    t.widget<TextField>(f.at(1)).controller?.text = pw;
    await t.pump();
    await t.tap(find.text('دخول'));
    await reach(t, 'signed-in', find.text('تسجيل الخروج'), to: const Duration(seconds: 40));
  }

  Future<void> teacherPost(String body) async {
    final login = await http.post(Uri.parse('$_api/auth/login'),
        headers: {'content-type': 'application/json'},
        body: jsonEncode({'identifier': _teacherEmail, 'password': _teacherPw, 'device': {'platform': 'web'}}));
    final token = (jsonDecode(login.body) as Map)['accessToken'];
    await http.post(Uri.parse('$_api/messaging/conversations/$_dm/messages/text'),
        headers: {'content-type': 'application/json', 'authorization': 'Bearer $token'},
        body: jsonEncode({'clientMessageId': 'rt-${DateTime.now().microsecondsSinceEpoch}', 'body': body}));
  }

  testWidgets('A. teacher sees the real academic roster in the browser', (t) async {
    try {
      app.main();
      await reach(t, 'shell', find.byIcon(Icons.person_outline_rounded));
      await ensureSignedOut(t);
      await signIn(t, _teacherEmail, _teacherPw);
      // Already on the profile after sign-in; the quick-links card is below the
      // account section, so tapText scrolls the lazy CustomScrollView to it.
      await tapText(t, 'حلقاتي كمعلّم'); // teacher workspace entry (gated academic.teach)
      if (await reach(t, 'workspace-halaqa', find.text(_halaqaName))) {
        await tapText(t, _halaqaName);
        await reach(t, 'roster-student', find.text(_studentName));
      }
    } catch (e) {
      steps.add('EXC academic: ${e.toString().split('\n').first}');
    }
    binding.reportData = {'steps': steps};
    final trail = steps.join(' | ');
    expect(steps, contains('OK workspace-halaqa'), reason: trail);
    expect(steps, contains('OK roster-student'), reason: trail);
  });

  testWidgets('B. student reads, sees an attachment, sends, and gets a realtime update', (t) async {
    try {
      app.main();
      await reach(t, 'shell2', find.byIcon(Icons.person_outline_rounded));
      await ensureSignedOut(t);
      await signIn(t, _studentEmail, _studentPw);
      await tapText(t, 'الرسائل');
      // Open the direct conversation.
      if (await reach(t, 'conv-list', find.byType(ConversationTile))) {
        await t.tap(find.byType(ConversationTile).first);
        // Read the seeded message + the image attachment's caption.
        await reach(t, 'read-seeded', find.text(_seededText));
        await reach(t, 'attachment-shown', find.text(_imageCaption));
        // Send a message through the composer.
        final composer = find.byType(TextField).last;
        t.widget<TextField>(composer).controller?.text = 'رسالة من المتصفح';
        await t.pump(const Duration(milliseconds: 300));
        await t.tap(find.byIcon(Icons.send_rounded).last);
        await reach(t, 'sent-appears', find.text('رسالة من المتصفح'));
        // Realtime: the teacher posts over the API; the open UI must reflect it.
        await teacherPost('بثّ فوري للطالب');
        await reach(t, 'realtime-appears', find.text('بثّ فوري للطالب'), to: const Duration(seconds: 30));
      }
    } catch (e) {
      steps.add('EXC messaging: ${e.toString().split('\n').first}');
    }
    binding.reportData = {'steps': steps};
    final trail = steps.join(' | ');
    expect(steps, contains('OK read-seeded'), reason: trail);
    expect(steps, contains('OK attachment-shown'), reason: trail);
    expect(steps, contains('OK sent-appears'), reason: trail);
    expect(steps, contains('OK realtime-appears'), reason: trail);
  });
}
