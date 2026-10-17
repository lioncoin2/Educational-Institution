import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/profile/sessions_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The device/session surface. It lists the caller's own sessions from the
/// contract (device, last-used, which is this device), lets the user end any
/// OTHER session (confirmed, with refresh), never offers to end THIS device
/// (sign-out owns that), and surfaces load/refusal failures without stranding
/// the UI. All network access is the repository's — the screen calls the
/// controller only. These tests pin that contract.
class _FakeAuth implements AuthRepository {
  _FakeAuth(this._sessions, {this.loadError, this.endError});

  List<DeviceSession> _sessions;
  final Object? loadError;
  final AuthException? endError;
  final List<String> ended = [];
  int loads = 0;

  @override
  Future<List<DeviceSession>> sessions() async {
    loads++;
    if (loadError != null) throw loadError!;
    return List.of(_sessions);
  }

  @override
  Future<void> endSession(String sessionId) async {
    ended.add(sessionId);
    if (endError != null) throw endError!;
    _sessions = _sessions.where((s) => s.id != sessionId).toList();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

DeviceSession _session({
  required String id,
  required String platform,
  String? label,
  required bool current,
}) => DeviceSession(
  id: id,
  platform: platform,
  label: label,
  lastUsedAt: DateTime(2026, 10, 10, 9, 30),
  current: current,
);

Future<void> _pump(WidgetTester tester, _FakeAuth auth) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [authRepositoryProvider.overrideWithValue(auth)],
      child: const MaterialApp(home: SessionsScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists the sessions and marks this device, no end on current', (
    tester,
  ) async {
    final auth = _FakeAuth([
      _session(id: 's-web', platform: 'web', current: true),
      _session(id: 's-droid', platform: 'android', current: false),
    ]);
    await _pump(tester, auth);

    expect(find.text('متصفّح ويب'), findsOneWidget);
    expect(find.text('جهاز أندرويد'), findsOneWidget);
    expect(find.text('هذا الجهاز'), findsOneWidget);
    // One end action — for the other device only; never for this device.
    expect(find.widgetWithText(TextButton, 'إنهاء'), findsOneWidget);
  });

  testWidgets('a current-only list offers no way to end this device here', (
    tester,
  ) async {
    final auth = _FakeAuth([
      _session(id: 's-web', platform: 'web', current: true),
    ]);
    await _pump(tester, auth);

    expect(find.text('هذا الجهاز'), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'إنهاء'), findsNothing);
  });

  testWidgets('a load failure shows an error with retry', (tester) async {
    final auth = _FakeAuth(
      const [],
      loadError: const AuthException('network.unreachable', 'offline'),
    );
    await _pump(tester, auth);

    expect(find.text('تعذّر الاتصال بالخادم.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'إعادة المحاولة'), findsOneWidget);
    expect(auth.loads, 1);
  });

  testWidgets('confirming end on another device ends it and refreshes', (
    tester,
  ) async {
    final auth = _FakeAuth([
      _session(id: 's-web', platform: 'web', current: true),
      _session(id: 's-droid', platform: 'android', current: false),
    ]);
    await _pump(tester, auth);

    await tester.tap(find.widgetWithText(TextButton, 'إنهاء'));
    await tester.pumpAndSettle();
    // Confirm in the dialog (the FilledButton, distinct from the row's TextButton).
    await tester.tap(find.widgetWithText(FilledButton, 'إنهاء'));
    await tester.pumpAndSettle();

    expect(auth.ended, ['s-droid']);
    expect(auth.loads, 2); // initial + post-end refresh
    expect(find.text('جهاز أندرويد'), findsNothing); // revoked row is gone
    expect(find.text('أُنهيت الجلسة.'), findsOneWidget);
  });

  testWidgets('cancelling the dialog ends nothing', (tester) async {
    final auth = _FakeAuth([
      _session(id: 's-web', platform: 'web', current: true),
      _session(id: 's-droid', platform: 'android', current: false),
    ]);
    await _pump(tester, auth);

    await tester.tap(find.widgetWithText(TextButton, 'إنهاء'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'إلغاء'));
    await tester.pumpAndSettle();

    expect(auth.ended, isEmpty);
    expect(find.text('جهاز أندرويد'), findsOneWidget);
  });

  testWidgets('a server refusal is surfaced and the list reconciles', (
    tester,
  ) async {
    final auth = _FakeAuth(
      [
        _session(id: 's-web', platform: 'web', current: true),
        _session(id: 's-droid', platform: 'android', current: false),
      ],
      endError: const AuthException(
        'identity.session_not_found',
        'No such session.',
      ),
    );
    await _pump(tester, auth);

    await tester.tap(find.widgetWithText(TextButton, 'إنهاء'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'إنهاء'));
    await tester.pumpAndSettle();

    expect(auth.ended, ['s-droid']);
    expect(find.text('لم تعد هذه الجلسة موجودة.'), findsOneWidget);
    expect(auth.loads, 2); // reconciled with the server after the refusal
  });
}
