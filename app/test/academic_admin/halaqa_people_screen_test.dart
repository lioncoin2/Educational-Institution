import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/people.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/academic_admin/academic_people_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// Administering a halaqa's students and teachers: a holder of academic.manage
/// (OWNER/ADMIN) finds a person through the people directory and enrols or
/// assigns them; the server (the fakes here) stays the authority and confirms
/// eligibility — a refusal is said in words. A viewer without academic.manage
/// sees the rosters but no controls. Discovery is never the authorization.

/// The institution directory the picker searches — shared so the roster can
/// resolve a newly added person's name (the enrol/assign carries only an id).
const _directory = {'u:s2': 'طالبة جديدة', 'u:t2': 'أستاذة جديدة'};

DateTime get _at => DateTime.utc(2026, 9, 1, 8);

class _FakePeople implements PeopleRepository {
  @override
  Future<PeopleSearchPage> search(String query, {String? cursor}) async =>
      PeopleSearchPage(
        items: [
          for (final e in _directory.entries)
            if (e.value.contains(query.trim()))
              PersonSearchResult(userId: e.key, displayName: e.value),
        ],
      );

  @override
  Future<PeopleSearchPage> searchTeachers(String query, {String? cursor}) =>
      throw UnimplementedError();
}

class _FakeAcademic implements AcademicRepository {
  _FakeAcademic({this.failRelationWith});

  String? failRelationWith;
  final List<String> writes = [];
  int _seq = 0;

  final List<HalaqaRosterEntry> _students = [
    HalaqaRosterEntry(
      enrollment: EnrollmentRecord(
        id: 'e:1',
        studentUserId: 'u:s1',
        halaqaId: 'h:1',
        status: EnrollmentStatus.active,
        enrolledAt: DateTime.utc(2026, 9, 1, 8),
      ),
      student: const AcademicPerson(
        userId: 'u:s1',
        displayName: 'مريم',
        active: true,
      ),
    ),
  ];
  final List<HalaqaTeacherEntry> _teachers = [
    HalaqaTeacherEntry(
      assignment: AssignmentRecord(
        id: 'a:1',
        halaqaId: 'h:1',
        teacherUserId: 'u:t1',
        role: TeachingRole.teacher,
        status: AssignmentStatus.active,
        startedAt: DateTime.utc(2026, 9, 1, 8),
      ),
      teacher: const AcademicPerson(
        userId: 'u:t1',
        displayName: 'الأستاذة عائشة',
        active: true,
      ),
    ),
  ];

  void _maybeFail() {
    final code = failRelationWith;
    if (code != null) throw AcademicException(code, code);
  }

  @override
  DataOrigin get origin => DataOrigin.records;

  @override
  Future<AcademicPage<HalaqaRosterEntry>> halaqaStudents(
    String halaqaId, {
    String? status,
    String? cursor,
  }) async => AcademicPage(items: List.of(_students));

  @override
  Future<EnrollmentRecord> enrollStudent(
    String halaqaId, {
    required String studentUserId,
  }) async {
    writes.add('enroll $studentUserId');
    _maybeFail();
    final record = EnrollmentRecord(
      id: 'e:${++_seq}',
      studentUserId: studentUserId,
      halaqaId: halaqaId,
      status: EnrollmentStatus.active,
      enrolledAt: _at,
    );
    _students.add(
      HalaqaRosterEntry(
        enrollment: record,
        student: AcademicPerson(
          userId: studentUserId,
          displayName: _directory[studentUserId],
          active: true,
        ),
      ),
    );
    return record;
  }

  @override
  Future<EnrollmentRecord> endEnrollment(
    String enrollmentId, {
    required EnrollmentOutcome outcome,
  }) async {
    writes.add('endEnrollment $enrollmentId ${outcome.wire}');
    _maybeFail();
    final entry = _students.firstWhere((e) => e.enrollment.id == enrollmentId);
    _students.remove(entry); // no longer ACTIVE → leaves the current roster
    return EnrollmentRecord(
      id: enrollmentId,
      studentUserId: entry.enrollment.studentUserId,
      halaqaId: entry.enrollment.halaqaId,
      status: EnrollmentStatus.completed,
      enrolledAt: entry.enrollment.enrolledAt,
      endedAt: _at,
    );
  }

  @override
  Future<AcademicPage<HalaqaTeacherEntry>> halaqaTeachers(
    String halaqaId, {
    String? status,
    String? cursor,
  }) async => AcademicPage(items: List.of(_teachers));

  @override
  Future<AssignmentRecord> assignTeacher(
    String halaqaId, {
    required String teacherUserId,
    required TeachingRole role,
  }) async {
    writes.add('assign $teacherUserId ${role.wire}');
    _maybeFail();
    final record = AssignmentRecord(
      id: 'a:${++_seq}',
      halaqaId: halaqaId,
      teacherUserId: teacherUserId,
      role: role,
      status: AssignmentStatus.active,
      startedAt: _at,
    );
    _teachers.add(
      HalaqaTeacherEntry(
        assignment: record,
        teacher: AcademicPerson(
          userId: teacherUserId,
          displayName: _directory[teacherUserId],
          active: true,
        ),
      ),
    );
    return record;
  }

  @override
  Future<AssignmentRecord> endAssignment(String assignmentId) async {
    writes.add('endAssignment $assignmentId');
    _maybeFail();
    final entry = _teachers.firstWhere((e) => e.assignment.id == assignmentId);
    _teachers.remove(entry);
    return AssignmentRecord(
      id: assignmentId,
      halaqaId: entry.assignment.halaqaId,
      teacherUserId: entry.assignment.teacherUserId,
      role: entry.assignment.role,
      status: AssignmentStatus.ended,
      startedAt: entry.assignment.startedAt,
      endedAt: _at,
    );
  }

  // Not exercised by the people screen.
  @override
  Object noSuchMethod(Invocation invocation) => throw UnimplementedError(
    'unexpected ${invocation.memberName} on the people-screen fake',
  );
}

CurrentUser _user(Set<String> permissions) => CurrentUser(
  id: 'me',
  displayName: 'مسؤولة',
  status: AccountStatus.active,
  roles: const [],
  permissions: permissions,
);

void main() {
  final enroll = find.byKey(const Key('enroll-student-button'));
  final assign = find.byKey(const Key('assign-teacher-button'));
  final search = find.byKey(const Key('person-picker-search'));

  List<Override> overrides(_FakeAcademic repo, CurrentUser user) => [
    academicRepositoryProvider.overrideWithValue(repo),
    peopleRepositoryProvider.overrideWithValue(_FakePeople()),
    backendModeProvider.overrideWithValue(true),
    sessionUserProvider.overrideWith((ref) async => user),
  ];

  Future<void> open(
    WidgetTester tester, {
    required _FakeAcademic repo,
    required CurrentUser user,
  }) => openApp(
    tester,
    Routes.academicHalaqaPeople('h:1'),
    overrides: overrides(repo, user),
  );

  Future<void> pick(WidgetTester tester, String name) async {
    await tester.enterText(search, name);
    await tester.pump(const Duration(milliseconds: 350)); // past the debounce
    await tester.pumpAndSettle();
    await tester.tap(find.text(name).last);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'lists the current students and, on the other tab, the teachers',
    (tester) async {
      await open(
        tester,
        repo: _FakeAcademic(),
        user: _user({'academic.manage'}),
      );
      expect(find.text('مريم'), findsOneWidget);

      await tester.tap(find.text(AcademicPeopleCopy.teachersTab));
      await tester.pumpAndSettle();
      expect(find.text('الأستاذة عائشة'), findsOneWidget);
    },
  );

  testWidgets('withholds every control from a viewer without academic.manage', (
    tester,
  ) async {
    await open(tester, repo: _FakeAcademic(), user: _user({'academic.read'}));
    expect(find.text('مريم'), findsOneWidget); // the roster is still readable
    expect(enroll, findsNothing);
    expect(find.byIcon(Icons.more_vert), findsNothing);
  });

  testWidgets('enrols a chosen student — asks the server, then shows them', (
    tester,
  ) async {
    final repo = _FakeAcademic();
    await open(tester, repo: repo, user: _user({'academic.manage'}));

    await tester.tap(enroll);
    await tester.pumpAndSettle();
    await pick(tester, 'طالبة جديدة');

    expect(repo.writes, contains('enroll u:s2'));
    expect(find.text(AcademicPeopleCopy.enrolled), findsOneWidget);
    expect(find.text('طالبة جديدة'), findsOneWidget);
  });

  testWidgets('a refused enrolment is said in words, and adds nobody', (
    tester,
  ) async {
    final repo = _FakeAcademic(
      failRelationWith: 'academic.student_not_eligible',
    );
    await open(tester, repo: repo, user: _user({'academic.manage'}));

    await tester.tap(enroll);
    await tester.pumpAndSettle();
    await pick(tester, 'طالبة جديدة');

    expect(
      find.text(
        AcademicPeopleCopy.relationFailed('academic.student_not_eligible'),
      ),
      findsOneWidget,
    );
    expect(find.text('طالبة جديدة'), findsNothing); // not added to the roster
  });

  testWidgets('assigns a teacher after choosing a role', (tester) async {
    final repo = _FakeAcademic();
    await open(tester, repo: repo, user: _user({'academic.manage'}));

    await tester.tap(find.text(AcademicPeopleCopy.teachersTab));
    await tester.pumpAndSettle();
    await tester.tap(assign);
    await tester.pumpAndSettle();
    await pick(tester, 'أستاذة جديدة');

    // The role chooser stands between selection and the write.
    await tester.tap(find.text(AcademicPeopleCopy.role(TeachingRole.teacher)));
    await tester.pumpAndSettle();

    expect(repo.writes, contains('assign u:t2 TEACHER'));
    expect(find.text(AcademicPeopleCopy.assigned), findsOneWidget);
    expect(find.text('أستاذة جديدة'), findsOneWidget);
  });

  testWidgets('ends an enrolment after choosing an outcome', (tester) async {
    final repo = _FakeAcademic();
    await open(tester, repo: repo, user: _user({'academic.manage'}));

    await tester.tap(find.byIcon(Icons.more_vert).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text(AcademicPeopleCopy.endEnrollment));
    await tester.pumpAndSettle();
    await tester.tap(
      find.text(AcademicPeopleCopy.outcomeLabel(EnrollmentOutcome.completed)),
    );
    await tester.pumpAndSettle();

    expect(repo.writes, contains('endEnrollment e:1 COMPLETED'));
    expect(find.text(AcademicPeopleCopy.enrollmentEnded), findsOneWidget);
    expect(find.text('مريم'), findsNothing); // left the current roster
  });
}
