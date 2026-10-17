import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/teacher/teacher_roster_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Sprint 56 — a teacher contacts a student from the halaqa roster. The row
/// reuses the shared [StartDirectMessageButton] with the student's real id from
/// the roster response; the server (staff `messaging.start_direct`) authorises
/// and is idempotent. These tests pin the roster-specific behaviour: the real
/// id is passed and the conversation opens, the action is gated by capability,
/// and a suspended student is not offered it. The button's loading/refusal/
/// double-tap behaviour is covered once in the student messaging test.
class _FakeAcademic implements AcademicRepository {
  _FakeAcademic(this.students);

  final List<HalaqaRosterEntry> students;

  @override
  Future<AcademicPage<HalaqaRosterEntry>> halaqaStudents(
    String halaqaId, {
    String? status,
    String? cursor,
  }) async => AcademicPage(items: students);

  @override
  Future<AcademicPage<HalaqaTeacherEntry>> halaqaTeachers(
    String halaqaId, {
    String? status,
    String? cursor,
  }) async => const AcademicPage(items: []);

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _FakeMessaging implements MessagingRepository {
  final List<String> started = [];

  @override
  Future<Conversation> startDirect(String userId) async {
    started.add(userId);
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

HalaqaRosterEntry _student(String userId, String name, {bool active = true}) =>
    HalaqaRosterEntry.fromJson({
      'enrollment': {
        'id': 'enr-$userId',
        'studentUserId': userId,
        'halaqaId': 'h1',
        'status': 'ACTIVE',
        'enrolledAt': '2026-10-01T00:00:00.000Z',
      },
      'student': {'userId': userId, 'displayName': name, 'active': active},
    });

CurrentUser _teacher({required bool canMessage}) => CurrentUser(
  id: 'teacher-me',
  displayName: 'الأستاذ عمر',
  status: AccountStatus.active,
  roles: const ['TEACHER'],
  permissions: {
    'academic.teach',
    if (canMessage) 'messaging.start_direct',
  },
);

Future<void> _pump(
  WidgetTester tester, {
  required bool canMessage,
  required _FakeAcademic academic,
  required _FakeMessaging messaging,
}) async {
  final router = GoRouter(
    initialLocation: '/roster',
    routes: [
      GoRoute(
        path: '/roster',
        builder: (context, state) =>
            const TeacherRosterScreen(halaqaId: 'h1', halaqaName: 'حلقة الفجر'),
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
        academicRepositoryProvider.overrideWithValue(academic),
        messagingRepositoryProvider.overrideWithValue(messaging),
        sessionUserProvider.overrideWith(
          (ref) async => _teacher(canMessage: canMessage),
        ),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('messages a student with their real roster id and opens it', (
    tester,
  ) async {
    final messaging = _FakeMessaging();
    await _pump(
      tester,
      canMessage: true,
      academic: _FakeAcademic([_student('s-1', 'آمنة')]),
      messaging: messaging,
    );

    final action = find.byKey(const Key('message-student-s-1'));
    expect(action, findsOneWidget);
    await tester.tap(action);
    await tester.pumpAndSettle();

    expect(messaging.started, ['s-1']); // the real id, not inferred
    expect(find.text('CONVO c-1'), findsOneWidget);
  });

  testWidgets('offers no message action without the start-direct capability', (
    tester,
  ) async {
    final messaging = _FakeMessaging();
    await _pump(
      tester,
      canMessage: false,
      academic: _FakeAcademic([_student('s-1', 'آمنة')]),
      messaging: messaging,
    );

    expect(find.text('آمنة'), findsOneWidget); // the student still shows
    expect(find.byKey(const Key('message-student-s-1')), findsNothing);
    expect(messaging.started, isEmpty);
  });

  testWidgets('offers no message action for a suspended student', (
    tester,
  ) async {
    final messaging = _FakeMessaging();
    await _pump(
      tester,
      canMessage: true,
      academic: _FakeAcademic([_student('s-2', 'سارة', active: false)]),
      messaging: messaging,
    );

    expect(find.text('سارة'), findsOneWidget);
    expect(find.byKey(const Key('message-student-s-2')), findsNothing);
  });
}
