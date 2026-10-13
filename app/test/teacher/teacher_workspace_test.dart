import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/teacher/teacher_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// The teacher workspace: a teacher sees their OWN active halaqat (from
/// /academic/me, answered by the authenticated identity) and opens each one's
/// read-only student roster (/academic/halaqat/:id/students, server-scoped per
/// halaqa). A halaqa they do not actively teach is refused, not shown empty;
/// ended assignments are excluded; a non-teacher never sees the entry. The
/// server (the fake here) is the authority; no management controls appear.

Map<String, Object?> _placement(String halaqaId, String halaqa) => {
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
    'id': halaqaId,
    'code': 'h',
    'name': halaqa,
    'order': 1,
    'status': 'ACTIVE',
  },
};

Map<String, Object?> _teaching(
  String halaqaId,
  String halaqa, {
  String role = 'TEACHER',
  String status = 'ACTIVE',
}) => {
  'assignment': {
    'id': 'asg-$halaqaId',
    'halaqaId': halaqaId,
    'role': role,
    'status': status,
    'startedAt': '2026-09-01T08:00:00.000Z',
    'endedAt': status == 'ACTIVE' ? null : '2026-10-01T08:00:00.000Z',
  },
  'placement': _placement(halaqaId, halaqa),
};

HalaqaRosterEntry _rosterStudent(
  String id,
  String name, {
  bool active = true,
}) => HalaqaRosterEntry.fromJson({
  'enrollment': {
    'id': 'e-$id',
    'studentUserId': id,
    'halaqaId': 'h:1',
    'status': 'ACTIVE',
    'enrolledAt': '2026-09-01T08:00:00.000Z',
    'endedAt': null,
  },
  'student': {'userId': id, 'displayName': name, 'active': active},
});

class _FakeAcademic implements AcademicRepository {
  _FakeAcademic({
    this.teaching = const [],
    this.rosterPages = const {},
    this.meFailWith,
    this.rosterFailWith,
    this.truncated = false,
  });

  final List<Map<String, Object?>> teaching;
  final Map<String?, AcademicPage<HalaqaRosterEntry>> rosterPages;
  final String? meFailWith;
  final String? rosterFailWith;
  final bool truncated;

  @override
  DataOrigin get origin => DataOrigin.records;

  @override
  Future<MyAcademic> me() async {
    final code = meFailWith;
    if (code != null) throw AcademicException(code, code);
    // Parsed through the real wire parser, teaching rows and all.
    return MyAcademic.fromJson({
      'enrollments': const <Object?>[],
      'teaching': teaching,
      'truncated': truncated,
    });
  }

  @override
  Future<AcademicPage<HalaqaRosterEntry>> halaqaStudents(
    String halaqaId, {
    String? status,
    String? cursor,
  }) async {
    final code = rosterFailWith;
    if (code != null) throw AcademicException(code, code);
    return rosterPages[cursor] ?? const AcademicPage(items: []);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

CurrentUser _user(Set<String> permissions) => CurrentUser(
  id: 'me',
  displayName: 'الأستاذة عائشة',
  status: AccountStatus.active,
  roles: const [],
  permissions: permissions,
);

const _teacher = {'academic.read', 'academic.teach'};
const _student = {'academic.read', 'academic.study'};

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
    overrides: overrides(repo, user ?? _user(_teacher)),
  );

  testWidgets('lists the teacher own active halaqat, excluding ended ones', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      teaching: [
        _teaching('h:1', 'حلقة ألف'),
        _teaching('h:2', 'حلقة قديمة', status: 'ENDED'),
      ],
    );
    await open(tester, Routes.teacherWorkspace, repo: repo);

    expect(find.text(TeacherCopy.workspaceTitle), findsOneWidget);
    expect(find.text('حلقة ألف'), findsOneWidget);
    expect(find.text('قسم التجويد · برنامج التجويد'), findsOneWidget);
    expect(find.text(TeacherCopy.role(TeachingRole.teacher)), findsOneWidget);
    // An ended assignment is not current.
    expect(find.text('حلقة قديمة'), findsNothing);
  });

  testWidgets('notes when the server lists only some of the halaqat', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      teaching: [_teaching('h:1', 'حلقة ألف')],
      truncated: true,
    );
    await open(tester, Routes.teacherWorkspace, repo: repo);
    expect(find.text('حلقة ألف'), findsOneWidget);
    expect(find.text(TeacherCopy.truncatedNote), findsOneWidget);
  });

  testWidgets('shows an empty state when no halaqat are assigned', (
    tester,
  ) async {
    await open(tester, Routes.teacherWorkspace, repo: _FakeAcademic());
    expect(find.text(TeacherCopy.empty), findsOneWidget);
  });

  testWidgets('an unauthorized workspace read is said in words', (
    tester,
  ) async {
    final repo = _FakeAcademic(meFailWith: 'identity.permission_denied');
    await open(tester, Routes.teacherWorkspace, repo: repo);
    expect(
      find.text(TeacherCopy.workspaceFailed('identity.permission_denied')),
      findsOneWidget,
    );
    expect(find.text(TeacherCopy.empty), findsNothing);
  });

  testWidgets('opens the read-only roster for a tapped halaqa', (tester) async {
    final repo = _FakeAcademic(
      teaching: [_teaching('h:1', 'حلقة ألف')],
      rosterPages: {
        null: AcademicPage(items: [_rosterStudent('u:s1', 'مريم')]),
      },
    );
    await open(tester, Routes.teacherWorkspace, repo: repo);
    await tester.tap(find.text('حلقة ألف'));
    await tester.pumpAndSettle();

    expect(find.text(TeacherCopy.rosterTitle), findsOneWidget);
    expect(find.text('مريم'), findsOneWidget);
    // Read-only: no management affordances.
    expect(find.byType(PopupMenuButton<String>), findsNothing);
    expect(find.byIcon(Icons.more_vert), findsNothing);
    expect(find.byType(FloatingActionButton), findsNothing);
  });

  testWidgets('a halaqa the teacher cannot access is refused, not empty', (
    tester,
  ) async {
    final repo = _FakeAcademic(rosterFailWith: 'academic.halaqa_access_denied');
    await open(tester, Routes.teacherHalaqaRoster('h:9'), repo: repo);
    expect(
      find.text(TeacherCopy.rosterFailed('academic.halaqa_access_denied')),
      findsOneWidget,
    );
    expect(find.text(TeacherCopy.noStudents), findsNothing);
  });

  testWidgets('an empty roster shows the empty state, not an error', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      rosterPages: {null: const AcademicPage(items: [])},
    );
    await open(tester, Routes.teacherHalaqaRoster('h:1'), repo: repo);
    expect(tester.takeException(), isNull);
    expect(find.text(TeacherCopy.noStudents), findsOneWidget);
  });

  testWidgets('pages the roster by the keyset cursor', (tester) async {
    final repo = _FakeAcademic(
      rosterPages: {
        null: AcademicPage(
          items: [_rosterStudent('u:s1', 'مريم')],
          nextCursor: 'c2',
        ),
        'c2': AcademicPage(items: [_rosterStudent('u:s2', 'سارة')]),
      },
    );
    await open(tester, Routes.teacherHalaqaRoster('h:1'), repo: repo);
    expect(find.text('مريم'), findsOneWidget);
    expect(find.text('سارة'), findsNothing);

    await tester.tap(find.text(TeacherCopy.loadMore));
    await tester.pumpAndSettle();
    expect(find.text('مريم'), findsOneWidget);
    expect(find.text('سارة'), findsOneWidget);
  });

  // The entry's gating is purely sessionUser.can('academic.teach'); the profile
  // renders in demo mode without touching the academic repository.
  testWidgets('the workspace entry is shown to a teacher, hidden from others', (
    tester,
  ) async {
    await openApp(
      tester,
      Routes.profile,
      overrides: [
        sessionUserProvider.overrideWith((ref) async => _user(_teacher)),
      ],
    );
    expect(find.text(TeacherCopy.workspaceTitle), findsOneWidget);
  });

  testWidgets('a non-teacher never sees the workspace entry', (tester) async {
    await openApp(
      tester,
      Routes.profile,
      overrides: [
        sessionUserProvider.overrideWith((ref) async => _user(_student)),
      ],
    );
    expect(find.text(TeacherCopy.workspaceTitle), findsNothing);
  });
}
