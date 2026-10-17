import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/student/student_workspace_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Sprint 55 — connecting حلقاتي to the existing teacher direct-messaging flow.
/// A student taps «مراسلة المعلّم» on a teacher of their own active enrollment;
/// the app reuses [DirectMessageStarter] with the teacher's real id from the
/// academic response, the server (idempotent per pair) opens or reuses the
/// conversation, and the app navigates to it. These tests pin: the real id is
/// passed, navigation happens, refusals surface without navigation, a double
/// tap starts once, and the affordance is gated by the viewer's capability.
class _FakeMessaging implements MessagingRepository {
  _FakeMessaging({this.error, this.gate});

  final MessagingException? error;
  /// When set, a start stays in flight until the test completes it — so a
  /// second tap arrives while the first request is still pending.
  final Completer<void>? gate;
  final List<String> started = [];

  @override
  Future<Conversation> startDirect(String userId) async {
    started.add(userId);
    if (gate != null) await gate!.future;
    if (error != null) throw error!;
    return Conversation.fromJson(const {
      'id': 'c-1',
      'type': 'DIRECT',
      'memberCount': 2,
      'myRole': 'MEMBER',
      'canPost': true,
      'canManageMembers': false,
      'lastSequence': 0,
      'lastReadSequence': 0,
      'unreadCount': 0,
      'createdAt': '2026-10-01T00:00:00.000Z',
      'activityAt': '2026-10-01T00:00:00.000Z',
    });
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _FakeAcademic implements AcademicRepository {
  _FakeAcademic(this.mine);

  final MyAcademic mine;

  @override
  Future<MyAcademic> me() async => mine;

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

MyAcademic _oneEnrollmentWithTeacher() => MyAcademic.fromJson({
  'enrollments': [
    {
      'enrollment': {
        'id': 'e1',
        'halaqaId': 'h1',
        'status': 'ACTIVE',
        'enrolledAt': '2026-10-01T08:00:00.000Z',
      },
      'placement': {
        'section': {
          'id': 's1',
          'code': 'sec-1',
          'name': 'قسم التجويد',
          'order': 1,
          'status': 'ACTIVE',
          'kind': 'SPECIAL',
        },
        'program': {
          'id': 'p1',
          'code': 'prog-1',
          'name': 'برنامج الإتقان',
          'order': 1,
          'status': 'ACTIVE',
        },
        'halaqa': {
          'id': 'h1',
          'code': 'hal-1',
          'name': 'حلقة الفجر',
          'order': 1,
          'status': 'ACTIVE',
        },
      },
      'teachers': [
        {'userId': 't-1', 'role': 'TEACHER', 'displayName': 'الأستاذ عمر'},
      ],
    },
  ],
  'teaching': const [],
  'truncated': false,
});

CurrentUser _user({required bool canMessageTeacher}) => CurrentUser(
  id: 'me',
  displayName: 'طالبة',
  status: AccountStatus.active,
  roles: const ['STUDENT'],
  permissions: {
    'academic.study',
    if (canMessageTeacher) 'messaging.start_direct_teacher',
  },
);

Future<void> _pump(
  WidgetTester tester, {
  required bool canMessageTeacher,
  required _FakeMessaging messaging,
  _FakeAcademic? academic,
}) async {
  final router = GoRouter(
    initialLocation: Routes.studentWorkspace,
    routes: [
      GoRoute(
        path: Routes.studentWorkspace,
        builder: (context, state) => const StudentWorkspaceScreen(),
      ),
      GoRoute(
        path: '/messages/:id',
        builder: (context, state) =>
            Scaffold(body: Text('CONVO ${state.pathParameters['id']}')),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        backendModeProvider.overrideWithValue(true),
        academicRepositoryProvider.overrideWithValue(
          academic ?? _FakeAcademic(_oneEnrollmentWithTeacher()),
        ),
        messagingRepositoryProvider.overrideWithValue(messaging),
        sessionUserProvider.overrideWith(
          (ref) async => _user(canMessageTeacher: canMessageTeacher),
        ),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  const action = Key('message-teacher-t-1');

  testWidgets('messages the teacher with the real enrollment id and opens it', (
    tester,
  ) async {
    final messaging = _FakeMessaging();
    await _pump(tester, canMessageTeacher: true, messaging: messaging);

    expect(find.byKey(action), findsOneWidget);
    await tester.tap(find.byKey(action));
    await tester.pumpAndSettle();

    // The teacher's actual id from the academic response was used — not inferred.
    expect(messaging.started, ['t-1']);
    // The existing conversation route was opened.
    expect(find.text('CONVO c-1'), findsOneWidget);
  });

  testWidgets('a refusal is surfaced and no navigation happens', (
    tester,
  ) async {
    final messaging = _FakeMessaging(
      error: const MessagingException(
        'messaging.participant_not_eligible',
        'not eligible',
      ),
    );
    await _pump(tester, canMessageTeacher: true, messaging: messaging);

    await tester.tap(find.byKey(action));
    await tester.pumpAndSettle();

    expect(messaging.started, ['t-1']);
    expect(find.text('CONVO c-1'), findsNothing); // stayed on the workspace
    expect(
      find.text('لا يمكنك بدء محادثة خاصة مع هذا الشخص.'),
      findsOneWidget,
    );
  });

  testWidgets('a double tap starts only one conversation', (tester) async {
    final gate = Completer<void>();
    final messaging = _FakeMessaging(gate: gate);
    await _pump(tester, canMessageTeacher: true, messaging: messaging);

    // Both taps land while the first start is still in flight (gated): the busy
    // guard must keep the second from firing an overlapping request.
    await tester.tap(find.byKey(action));
    await tester.tap(find.byKey(action), warnIfMissed: false);
    gate.complete();
    await tester.pumpAndSettle();

    expect(messaging.started, ['t-1']);
    expect(find.text('CONVO c-1'), findsOneWidget);
  });

  testWidgets('the affordance is hidden without the teacher-DM capability', (
    tester,
  ) async {
    final messaging = _FakeMessaging();
    await _pump(tester, canMessageTeacher: false, messaging: messaging);

    // The teacher still shows, but no message action is offered.
    expect(find.text('الأستاذ عمر — معلّم'), findsOneWidget);
    expect(find.byKey(action), findsNothing);
    expect(messaging.started, isEmpty);
  });
}
