import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/academic_admin/academic_history_copy.dart';
import 'package:quran_institution_app/features/academic_admin/academic_people_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// Read-only academic history: a holder of academic.manage opens one person's
/// enrolments/assignments (every status), reaches it from the halaqa roster,
/// pages by the keyset cursor, and sees an empty history told apart from a
/// refused one. A non-manager cannot open it. The server (the fake) is the
/// authority; a refusal is said in words, never fabricated data.

Map<String, Object?> _placement(String halaqa) => {
  'section': {
    'id': 's:1',
    'code': 'sec',
    'name': 'قسم التجويد',
    'order': 1,
    'status': 'ACTIVE',
    'kind': 'SPECIAL',
  },
  'program': {
    'id': 'p:1',
    'code': 'prog',
    'name': 'برنامج التجويد',
    'order': 1,
    'status': 'ACTIVE',
  },
  'halaqa': {
    'id': 'h:1',
    'code': 'h1',
    'name': halaqa,
    'order': 1,
    'status': 'ACTIVE',
  },
};

PlacedEnrollment _enr(
  String id,
  String halaqa, {
  String status = 'ACTIVE',
  String? endedAt,
}) => PlacedEnrollment.fromJson({
  'enrollment': {
    'id': id,
    'studentUserId': 'u:s1',
    'halaqaId': 'h:1',
    'status': status,
    'enrolledAt': '2026-09-01T08:00:00.000Z',
    'endedAt': endedAt,
  },
  'placement': _placement(halaqa),
});

PlacedAssignment _asg(
  String id,
  String halaqa, {
  String role = 'TEACHER',
  String status = 'ACTIVE',
  String? endedAt,
}) => PlacedAssignment.fromJson({
  'assignment': {
    'id': id,
    'halaqaId': 'h:1',
    'teacherUserId': 'u:t1',
    'role': role,
    'status': status,
    'startedAt': '2026-09-01T08:00:00.000Z',
    'endedAt': endedAt,
  },
  'placement': _placement(halaqa),
});

class _FakeAcademic implements AcademicRepository {
  _FakeAcademic({
    this.enrollmentPages = const {},
    this.assignmentPages = const {},
    this.failHistory,
  });

  final Map<String?, AcademicPage<PlacedEnrollment>> enrollmentPages;
  final Map<String?, AcademicPage<PlacedAssignment>> assignmentPages;
  final String? failHistory;

  @override
  DataOrigin get origin => DataOrigin.records;

  // A fixed one-person roster, so the history can be reached from it.
  @override
  Future<AcademicPage<HalaqaRosterEntry>> halaqaStudents(
    String halaqaId, {
    String? status,
    String? cursor,
  }) async => AcademicPage(
    items: [
      HalaqaRosterEntry.fromJson({
        'enrollment': {
          'id': 'e:1',
          'studentUserId': 'u:s1',
          'halaqaId': 'h:1',
          'status': 'ACTIVE',
          'enrolledAt': '2026-09-01T08:00:00.000Z',
          'endedAt': null,
        },
        'student': {'userId': 'u:s1', 'displayName': 'مريم', 'active': true},
      }),
    ],
  );

  @override
  Future<AcademicPage<HalaqaTeacherEntry>> halaqaTeachers(
    String halaqaId, {
    String? status,
    String? cursor,
  }) async => AcademicPage(
    items: [
      HalaqaTeacherEntry.fromJson({
        'assignment': {
          'id': 'a:1',
          'halaqaId': 'h:1',
          'teacherUserId': 'u:t1',
          'role': 'TEACHER',
          'status': 'ACTIVE',
          'startedAt': '2026-09-01T08:00:00.000Z',
          'endedAt': null,
        },
        'teacher': {
          'userId': 'u:t1',
          'displayName': 'الأستاذة عائشة',
          'active': true,
        },
      }),
    ],
  );

  @override
  Future<AcademicPage<PlacedEnrollment>> studentEnrollments(
    String userId, {
    String? cursor,
  }) async {
    final code = failHistory;
    if (code != null) throw AcademicException(code, code);
    return enrollmentPages[cursor] ?? const AcademicPage(items: []);
  }

  @override
  Future<AcademicPage<PlacedAssignment>> teacherAssignments(
    String userId, {
    String? cursor,
  }) async {
    final code = failHistory;
    if (code != null) throw AcademicException(code, code);
    return assignmentPages[cursor] ?? const AcademicPage(items: []);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

CurrentUser _user(Set<String> permissions) => CurrentUser(
  id: 'me',
  displayName: 'مسؤولة',
  status: AccountStatus.active,
  roles: const [],
  permissions: permissions,
);

void main() {
  List<Override> overrides(_FakeAcademic repo, CurrentUser user) => [
    academicRepositoryProvider.overrideWithValue(repo),
    backendModeProvider.overrideWithValue(true),
    sessionUserProvider.overrideWith((ref) async => user),
  ];

  Future<void> open(
    WidgetTester tester,
    String path, {
    required _FakeAcademic repo,
    CurrentUser? user,
  }) => openApp(
    tester,
    path,
    overrides: overrides(repo, user ?? _user({'academic.manage'})),
  );

  testWidgets('renders a student enrolment history — active and ended', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      enrollmentPages: {
        null: AcademicPage(
          items: [
            _enr('e:2', 'حلقة ألف'),
            _enr(
              'e:1',
              'حلقة باء',
              status: 'COMPLETED',
              endedAt: '2026-10-01T08:00:00.000Z',
            ),
          ],
        ),
      },
    );
    await open(tester, Routes.academicStudentHistory('u:s1'), repo: repo);

    expect(find.text(AcademicHistoryCopy.studentTitle), findsOneWidget);
    expect(find.text('حلقة ألف'), findsOneWidget);
    expect(find.text('حلقة باء'), findsOneWidget);
    expect(
      find.textContaining(
        AcademicPeopleCopy.enrollmentStatus(EnrollmentStatus.completed),
      ),
      findsOneWidget,
    );
  });

  testWidgets('an empty history shows the empty state, not an error', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      enrollmentPages: {null: const AcademicPage(items: [])},
    );
    await open(tester, Routes.academicStudentHistory('u:s1'), repo: repo);
    expect(tester.takeException(), isNull);
    expect(find.text(AcademicHistoryCopy.noEnrollments), findsOneWidget);
  });

  testWidgets('a refused history read is said in words, with no records', (
    tester,
  ) async {
    final repo = _FakeAcademic(failHistory: 'identity.permission_denied');
    await open(tester, Routes.academicStudentHistory('u:s1'), repo: repo);
    expect(
      find.text(
        AcademicHistoryCopy.historyFailed('identity.permission_denied'),
      ),
      findsOneWidget,
    );
    // The error path is told apart from an empty history.
    expect(find.text(AcademicHistoryCopy.noEnrollments), findsNothing);
  });

  testWidgets('pages the history by the keyset cursor', (tester) async {
    final repo = _FakeAcademic(
      enrollmentPages: {
        null: AcademicPage(items: [_enr('e:1', 'حلقة ألف')], nextCursor: 'c2'),
        'c2': AcademicPage(items: [_enr('e:2', 'حلقة باء')]),
      },
    );
    await open(tester, Routes.academicStudentHistory('u:s1'), repo: repo);
    expect(find.text('حلقة ألف'), findsOneWidget);
    expect(find.text('حلقة باء'), findsNothing);

    await tester.tap(find.text(AcademicHistoryCopy.loadMore));
    await tester.pumpAndSettle();
    expect(find.text('حلقة ألف'), findsOneWidget);
    expect(find.text('حلقة باء'), findsOneWidget);
  });

  testWidgets('renders a teacher assignment history with role and status', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      assignmentPages: {
        null: AcademicPage(
          items: [
            _asg('a:2', 'حلقة ألف'),
            _asg(
              'a:1',
              'حلقة باء',
              role: 'ASSISTANT_TEACHER',
              status: 'ENDED',
              endedAt: '2026-10-01T08:00:00.000Z',
            ),
          ],
        ),
      },
    );
    await open(tester, Routes.academicTeacherHistory('u:t1'), repo: repo);
    expect(find.text(AcademicHistoryCopy.teacherTitle), findsOneWidget);
    expect(
      find.textContaining(
        AcademicPeopleCopy.role(TeachingRole.assistantTeacher),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a manager reaches a student history from the roster', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      enrollmentPages: {
        null: AcademicPage(items: [_enr('e:9', 'حلقة ألف')]),
      },
    );
    await open(tester, Routes.academicHalaqaPeople('h:1'), repo: repo);
    await tester.tap(find.text('مريم'));
    await tester.pumpAndSettle();

    expect(find.text(AcademicHistoryCopy.studentTitle), findsOneWidget);
    expect(find.text('حلقة ألف'), findsOneWidget);
  });

  testWidgets('a non-manager cannot open history from the roster', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      enrollmentPages: {
        null: AcademicPage(items: [_enr('e:9', 'حلقة ألف')]),
      },
    );
    await open(
      tester,
      Routes.academicHalaqaPeople('h:1'),
      repo: repo,
      user: _user({'academic.read'}),
    );
    expect(find.text('مريم'), findsOneWidget); // the roster is readable
    await tester.tap(find.text('مريم'));
    await tester.pumpAndSettle();
    // The row is not tappable for a non-manager: no navigation happened.
    expect(find.text(AcademicHistoryCopy.studentTitle), findsNothing);
  });
}
