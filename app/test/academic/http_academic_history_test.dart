import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/repositories/http/http_academic_repository.dart';

/// Academic relationship history on the wire (Sprint 48, read-only): the path,
/// the keyset cursor, and how the `{items, nextCursor}` page parses — every
/// status, distinct records kept distinct, defensive about missing/malformed
/// rows, and a refusal kept as its code. An administrator's view
/// (`academic.manage`), re-authorised by the server.
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
  http.Response fail(int status, String code) => http.Response(
    jsonEncode({
      'error': {'kind': 'x', 'code': code, 'message': code},
    }),
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );

  Map<String, Object?> placement({String halaqa = 'الحلقة 1'}) => {
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
  Map<String, Object?> enrollment({
    required String id,
    String status = 'ACTIVE',
    String halaqaId = 'h:1',
    String? endedAt,
  }) => {
    'id': id,
    'studentUserId': 'u:s1',
    'halaqaId': halaqaId,
    'status': status,
    'enrolledAt': '2026-09-01T08:00:00.000Z',
    'endedAt': endedAt,
  };
  Map<String, Object?> assignment({
    required String id,
    String status = 'ACTIVE',
    String role = 'TEACHER',
    String? endedAt,
  }) => {
    'id': id,
    'halaqaId': 'h:1',
    'teacherUserId': 'u:t1',
    'role': role,
    'status': status,
    'startedAt': '2026-09-01T08:00:00.000Z',
    'endedAt': endedAt,
  };

  http.Request req() => recorded.last;

  test('reads a student history — path, keyset page, active + ended', () async {
    final repo = over(
      (_) => ok({
        'items': [
          {'enrollment': enrollment(id: 'e:1'), 'placement': placement()},
          {
            'enrollment': enrollment(
              id: 'e:0',
              status: 'COMPLETED',
              endedAt: '2026-10-01T08:00:00.000Z',
            ),
            'placement': placement(),
          },
        ],
        'nextCursor': 'c2',
      }),
    );
    final page = await repo.studentEnrollments('u:s1');
    expect(req().method, 'GET');
    expect(
      Uri.decodeComponent(req().url.path),
      '/academic/students/u:s1/enrollments',
    );
    expect(page.nextCursor, 'c2');
    expect(page.items, hasLength(2));
    expect(page.items.first.enrollment.isActive, isTrue);
    expect(page.items.last.enrollment.status, EnrollmentStatus.completed);
    expect(page.items.last.enrollment.endedAt, isNotNull);
    expect(page.items.first.placement.halaqa.name, 'الحلقة 1');
  });

  test('sends the keyset cursor for the next page', () async {
    final repo = over((_) => ok({'items': const [], 'nextCursor': null}));
    await repo.studentEnrollments('u:s1', cursor: 'c2');
    expect(req().url.queryParameters['cursor'], 'c2');
  });

  test('keeps distinct enrolments in the same halaqa — never merged', () async {
    final repo = over(
      (_) => ok({
        'items': [
          {
            'enrollment': enrollment(
              id: 'e:2',
              status: 'WITHDRAWN',
              endedAt: '2026-09-10T08:00:00.000Z',
            ),
            'placement': placement(),
          },
          {'enrollment': enrollment(id: 'e:3'), 'placement': placement()},
        ],
        'nextCursor': null,
      }),
    );
    final page = await repo.studentEnrollments('u:s1');
    // Two records, same halaqa (h:1), distinct ids — both kept.
    expect(page.items.map((e) => e.enrollment.id), ['e:2', 'e:3']);
    expect(page.items.every((e) => e.enrollment.halaqaId == 'h:1'), isTrue);
  });

  test('an empty history is an empty page, not an error', () async {
    final repo = over((_) => ok({'items': const [], 'nextCursor': null}));
    final page = await repo.studentEnrollments('u:s1');
    expect(page.items, isEmpty);
    expect(page.nextCursor, isNull);
  });

  test('skips a malformed row rather than failing the whole page', () async {
    final repo = over(
      (_) => ok({
        'items': [
          {'enrollment': enrollment(id: 'e:1'), 'placement': placement()},
          {'enrollment': enrollment(id: 'e:bad')}, // missing placement
        ],
        'nextCursor': null,
      }),
    );
    final page = await repo.studentEnrollments('u:s1');
    expect(page.items.map((e) => e.enrollment.id), ['e:1']);
  });

  test('a refused history read keeps the server code', () async {
    final repo = over((_) => fail(403, 'academic.historical_roster_denied'));
    await expectLater(
      repo.studentEnrollments('u:s1'),
      throwsA(
        isA<AcademicException>().having(
          (e) => e.code,
          'code',
          'academic.historical_roster_denied',
        ),
      ),
    );
  });

  test('reads a teacher history — role, status, placement, ended', () async {
    final repo = over(
      (_) => ok({
        'items': [
          {'assignment': assignment(id: 'a:1'), 'placement': placement()},
          {
            'assignment': assignment(
              id: 'a:0',
              role: 'ASSISTANT_TEACHER',
              status: 'ENDED',
              endedAt: '2026-10-01T08:00:00.000Z',
            ),
            'placement': placement(),
          },
        ],
        'nextCursor': null,
      }),
    );
    final page = await repo.teacherAssignments('u:t1');
    expect(
      Uri.decodeComponent(req().url.path),
      '/academic/teachers/u:t1/assignments',
    );
    expect(page.items.first.assignment.role, TeachingRole.teacher);
    expect(page.items.first.assignment.isActive, isTrue);
    expect(page.items.last.assignment.status, AssignmentStatus.ended);
    expect(page.items.last.assignment.role, TeachingRole.assistantTeacher);
    expect(page.items.last.assignment.endedAt, isNotNull);
  });
}
