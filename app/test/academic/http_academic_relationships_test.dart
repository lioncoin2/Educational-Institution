import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/repositories/http/http_academic_repository.dart';

/// The relationship administration on the wire (Sprint 46, owner-approved):
/// the method, the path (ids escaped), the body sent, the row parsed back, and
/// that a refusal keeps the server's code. These are an administrator's acts
/// (`academic.manage`); the server re-authorises and confirms eligibility — the
/// app only forms the request and reads the answer.
void main() {
  late InMemoryTokenStore tokens;
  final recorded = <http.Request>[];

  HttpAcademicRepository over(http.Response Function(http.Request) handler) {
    final client = MockClient((request) async {
      recorded.add(request);
      return handler(request);
    });
    return HttpAcademicRepository(
      ApiClient(
        baseUri: Uri.parse('https://api.test/'),
        httpClient: client,
        tokenStore: tokens,
      ),
    );
  }

  setUp(() async {
    recorded.clear();
    tokens = InMemoryTokenStore();
    await tokens.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
  });

  http.Response ok(Object body) => http.Response(
    jsonEncode(body),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
  http.Response created(Object body) => http.Response(
    jsonEncode(body),
    201,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
  http.Response fail(int status, String code) => http.Response(
    jsonEncode({
      'error': {'kind': 'x', 'code': code, 'message': code},
    }),
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );

  Map<String, Object?> enrollmentRow({String status = 'ACTIVE'}) => {
    'id': 'e:1',
    'studentUserId': 'u:s1',
    'halaqaId': 'h:1',
    'status': status,
    'enrolledAt': '2026-09-01T08:00:00.000Z',
    'endedAt': null,
  };
  Map<String, Object?> assignmentRow({
    String role = 'TEACHER',
    String status = 'ACTIVE',
  }) => {
    'id': 'a:1',
    'halaqaId': 'h:1',
    'teacherUserId': 'u:t1',
    'role': role,
    'status': status,
    'startedAt': '2026-09-01T08:00:00.000Z',
    'endedAt': null,
  };
  Map<String, Object?> person(String id, String name, {bool active = true}) => {
    'userId': id,
    'displayName': name,
    'active': active,
  };

  http.Request req() => recorded.single;
  Map<String, Object?> sentBody() =>
      (jsonDecode(req().body) as Map).cast<String, Object?>();
  String reqPath() => Uri.decodeComponent(req().url.path);

  group('students', () {
    test('reads the roster — GET …/students, status filter, parsed', () async {
      final repo = over(
        (_) => ok({
          'items': [
            {'enrollment': enrollmentRow(), 'student': person('u:s1', 'مريم')},
          ],
          'nextCursor': 'c2',
        }),
      );
      final page = await repo.halaqaStudents('h:1', status: 'ACTIVE');
      expect(req().method, 'GET');
      expect(reqPath(), '/academic/halaqat/h:1/students');
      expect(req().url.queryParameters['status'], 'ACTIVE');
      expect(page.nextCursor, 'c2');
      expect(page.items.single.student.displayName, 'مريم');
      expect(page.items.single.enrollment.studentUserId, 'u:s1');
      expect(page.items.single.enrollment.isActive, isTrue);
    });

    test(
      'enrols — POST …/enrollments, id-only body, reads the enrollment',
      () async {
        final repo = over(
          (_) => created({
            'enrollment': enrollmentRow(),
            'placement': <String, Object?>{},
          }),
        );
        final record = await repo.enrollStudent('h:1', studentUserId: 'u:s1');
        expect(req().method, 'POST');
        expect(reqPath(), '/academic/halaqat/h:1/enrollments');
        expect(req().url.path, '/academic/halaqat/h%3A1/enrollments');
        expect(sentBody(), {'studentUserId': 'u:s1'});
        expect(record.id, 'e:1');
        expect(record.studentUserId, 'u:s1');
      },
    );

    test('ends — POST …/enrollments/:id/end with the outcome', () async {
      final repo = over((_) => ok(enrollmentRow(status: 'WITHDRAWN')));
      final record = await repo.endEnrollment(
        'e:1',
        outcome: EnrollmentOutcome.withdrawn,
      );
      expect(req().method, 'POST');
      expect(reqPath(), '/academic/enrollments/e:1/end');
      expect(sentBody(), {'outcome': 'WITHDRAWN'});
      expect(record.status, EnrollmentStatus.withdrawn);
    });

    test('a not-eligible account keeps its code and enrols nobody', () async {
      final repo = over((_) => fail(422, 'academic.student_not_eligible'));
      await expectLater(
        repo.enrollStudent('h:1', studentUserId: 'u:x'),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.code,
            'code',
            'academic.student_not_eligible',
          ),
        ),
      );
    });

    test('ending an already-ended enrollment keeps its code', () async {
      final repo = over((_) => fail(409, 'academic.enrollment_already_ended'));
      await expectLater(
        repo.endEnrollment('e:1', outcome: EnrollmentOutcome.completed),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.code,
            'code',
            'academic.enrollment_already_ended',
          ),
        ),
      );
    });
  });

  group('teachers', () {
    test('reads the teaching list — GET …/teachers, parsed', () async {
      final repo = over(
        (_) => ok({
          'items': [
            {
              'assignment': assignmentRow(role: 'ASSISTANT_TEACHER'),
              'teacher': person('u:t1', 'الأستاذة'),
            },
          ],
          'nextCursor': null,
        }),
      );
      final page = await repo.halaqaTeachers('h:1', status: 'ACTIVE');
      expect(reqPath(), '/academic/halaqat/h:1/teachers');
      expect(page.items.single.teacher.displayName, 'الأستاذة');
      expect(page.items.single.assignment.role, TeachingRole.assistantTeacher);
      expect(page.nextCursor, isNull);
    });

    test('assigns — POST …/teachers with id and role', () async {
      final repo = over((_) => created(assignmentRow()));
      final record = await repo.assignTeacher(
        'h:1',
        teacherUserId: 'u:t1',
        role: TeachingRole.teacher,
      );
      expect(req().method, 'POST');
      expect(reqPath(), '/academic/halaqat/h:1/teachers');
      expect(sentBody(), {'teacherUserId': 'u:t1', 'role': 'TEACHER'});
      expect(record.teacherUserId, 'u:t1');
      expect(record.role, TeachingRole.teacher);
    });

    test('ends — bodyless POST …/teacher-assignments/:id/end', () async {
      final repo = over((_) => ok(assignmentRow(status: 'ENDED')));
      final record = await repo.endAssignment('a:1');
      expect(req().method, 'POST');
      expect(reqPath(), '/academic/teacher-assignments/a:1/end');
      expect(req().body, isEmpty);
      expect(record.status, AssignmentStatus.ended);
    });

    test('a role clash keeps its code and assigns nobody', () async {
      final repo = over((_) => fail(409, 'academic.teacher_already_assigned'));
      await expectLater(
        repo.assignTeacher(
          'h:1',
          teacherUserId: 'u:t1',
          role: TeachingRole.assistantTeacher,
        ),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.code,
            'code',
            'academic.teacher_already_assigned',
          ),
        ),
      );
    });
  });
}
