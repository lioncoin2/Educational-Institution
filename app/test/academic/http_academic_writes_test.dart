import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/repositories/http/http_academic_repository.dart';

/// The structure-management writes, asserted on the wire: the method, the path
/// (ids escaped), the body sent, and the row parsed back. A refusal keeps the
/// server's code and does not become a success. These are the writes a holder
/// of `academic.manage` makes; the server re-authorises each one — this only
/// checks the request the app forms and the answer it reads.
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

  Map<String, Object?> sectionRow({
    String status = 'ACTIVE',
    String kind = 'SPECIAL',
    String? description,
  }) => {
    'id': 's:1',
    'code': 'sec',
    'name': 'قسم جديد',
    'kind': kind,
    'order': 2,
    'status': status,
    'description': description,
    'programs': <Object?>[],
  };
  Map<String, Object?> programRow({String status = 'ACTIVE'}) => {
    'id': 'p:1',
    'code': 'prog',
    'sectionId': 's:1',
    'name': 'برنامج جديد',
    'order': 3,
    'status': status,
    'activeHalaqaCount': 0,
    'description': null,
  };
  Map<String, Object?> halaqaRow({String status = 'ACTIVE'}) => {
    'id': 'h:1',
    'code': 'hal',
    'programId': 'p:1',
    'name': 'حلقة جديدة',
    'order': 4,
    'status': status,
  };

  http.Request req() => recorded.single;
  Map<String, Object?> sentBody() =>
      (jsonDecode(req().body) as Map).cast<String, Object?>();
  String reqPath() => Uri.decodeComponent(req().url.path);

  group('create', () {
    test(
      'a section — POST /academic/sections, full body, parsed back',
      () async {
        final repo = over((_) => ok(sectionRow()));
        final section = await repo.createSection(
          code: 'sec',
          name: 'قسم جديد',
          order: 2,
          kind: SectionKind.special,
          description: 'وصف',
        );
        expect(req().method, 'POST');
        expect(reqPath(), '/academic/sections');
        expect(sentBody(), {
          'code': 'sec',
          'name': 'قسم جديد',
          'order': 2,
          'kind': 'SPECIAL',
          'description': 'وصف',
        });
        expect(section.id, 's:1');
        expect(section.kind, SectionKind.special);
      },
    );

    test('omits description entirely when none is given', () async {
      final repo = over((_) => ok(sectionRow()));
      await repo.createSection(
        code: 'sec',
        name: 'قسم',
        order: 1,
        kind: SectionKind.progressive,
      );
      expect(sentBody().containsKey('description'), isFalse);
      expect(sentBody()['kind'], 'PROGRESSIVE');
    });

    test('a program — POST /academic/programs under its section', () async {
      final repo = over((_) => ok(programRow()));
      final program = await repo.createProgram(
        sectionId: 's:1',
        code: 'prog',
        name: 'برنامج جديد',
        order: 3,
      );
      expect(req().method, 'POST');
      expect(reqPath(), '/academic/programs');
      expect(sentBody(), {
        'sectionId': 's:1',
        'code': 'prog',
        'name': 'برنامج جديد',
        'order': 3,
      });
      expect(program.sectionId, 's:1');
    });

    test('a halaqa — POST /academic/halaqat, never a description', () async {
      final repo = over((_) => ok(halaqaRow()));
      final halaqa = await repo.createHalaqa(
        programId: 'p:1',
        code: 'hal',
        name: 'حلقة جديدة',
        order: 4,
      );
      expect(req().method, 'POST');
      expect(reqPath(), '/academic/halaqat');
      expect(sentBody(), {
        'programId': 'p:1',
        'code': 'hal',
        'name': 'حلقة جديدة',
        'order': 4,
      });
      expect(sentBody().containsKey('description'), isFalse);
      expect(halaqa.programId, 'p:1');
    });
  });

  group('edit — PATCH by the escaped id', () {
    test('a section sends name, order and description (null clears)', () async {
      final repo = over((_) => ok(sectionRow(description: null)));
      await repo.updateSection('s:1', name: 'اسم', order: 2);
      expect(req().method, 'PATCH');
      expect(reqPath(), '/academic/sections/s:1');
      expect(req().url.path, '/academic/sections/s%3A1');
      expect(sentBody(), {'name': 'اسم', 'order': 2, 'description': null});
    });

    test('a program sends name, order and description', () async {
      final repo = over((_) => ok(programRow()));
      await repo.updateProgram(
        'p:1',
        name: 'اسم',
        order: 3,
        description: 'وصف',
      );
      expect(req().method, 'PATCH');
      expect(reqPath(), '/academic/programs/p:1');
      expect(sentBody(), {'name': 'اسم', 'order': 3, 'description': 'وصف'});
    });

    test('a halaqa sends only name and order', () async {
      final repo = over((_) => ok(halaqaRow()));
      await repo.updateHalaqa('h:1', name: 'اسم', order: 4);
      expect(req().method, 'PATCH');
      expect(reqPath(), '/academic/halaqat/h:1');
      expect(sentBody(), {'name': 'اسم', 'order': 4});
    });
  });

  group('activate / deactivate — bodyless POST to the verb', () {
    test('a section', () async {
      final repo = over((_) => ok(sectionRow(status: 'INACTIVE')));
      final off = await repo.setSectionActive('s:1', active: false);
      expect(req().method, 'POST');
      expect(reqPath(), '/academic/sections/s:1/deactivate');
      expect(req().body, isEmpty);
      expect(off.status, StructureStatus.inactive);

      recorded.clear();
      final on = over((_) => ok(sectionRow()));
      await on.setSectionActive('s:1', active: true);
      expect(reqPath(), '/academic/sections/s:1/activate');
    });

    test('a program', () async {
      final repo = over((_) => ok(programRow(status: 'INACTIVE')));
      await repo.setProgramActive('p:1', active: false);
      expect(reqPath(), '/academic/programs/p:1/deactivate');
      expect(req().body, isEmpty);
    });

    test('a halaqa', () async {
      final repo = over((_) => ok(halaqaRow()));
      await repo.setHalaqaActive('h:1', active: true);
      expect(reqPath(), '/academic/halaqat/h:1/activate');
      expect(req().body, isEmpty);
    });
  });

  group('cover image (ADR 0038)', () {
    test('bind — PUT /academic/programs/:id/cover with the asset id', () async {
      final repo = over((_) => ok({...programRow(), 'coverFileAssetId': 'asset-x'}));
      final program = await repo.setProgramCover('p:1', 'asset-x');
      expect(req().method, 'PUT');
      expect(reqPath(), '/academic/programs/p:1/cover');
      expect(req().url.path, '/academic/programs/p%3A1/cover');
      expect(sentBody(), {'coverFileAssetId': 'asset-x'});
      expect(program.coverFileAssetId, 'asset-x');
    });

    test('clear — DELETE /academic/programs/:id/cover, no body', () async {
      final repo = over((_) => ok(programRow()));
      final program = await repo.clearProgramCover('p:1');
      expect(req().method, 'DELETE');
      expect(reqPath(), '/academic/programs/p:1/cover');
      expect(program.coverFileAssetId, isNull);
    });

    test('link — GET /academic/programs/:id/cover, resolved absolute', () async {
      final repo = over(
        (_) => ok({'url': '/files/local/abc?sig=x', 'expiresAt': '2026-10-21T00:05:00.000Z'}),
      );
      final url = await repo.programCoverUrl('p:1');
      expect(req().method, 'GET');
      expect(reqPath(), '/academic/programs/p:1/cover');
      expect(url, Uri.parse('https://api.test/files/local/abc?sig=x'));
    });
  });

  group('a refusal keeps its code and is not a success', () {
    test('a taken code on create', () async {
      final repo = over((_) => fail(409, 'academic.code_taken'));
      await expectLater(
        repo.createSection(
          code: 'sec',
          name: 'قسم',
          order: 1,
          kind: SectionKind.special,
        ),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.code,
            'code',
            'academic.code_taken',
          ),
        ),
      );
    });

    test('an invalid order on edit', () async {
      final repo = over((_) => fail(422, 'academic.order_invalid'));
      await expectLater(
        repo.updateProgram('p:1', name: 'اسم', order: 0),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.code,
            'code',
            'academic.order_invalid',
          ),
        ),
      );
    });

    test('active enrolments block a halaqa deactivate', () async {
      final repo = over(
        (_) => fail(409, 'academic.halaqa_has_active_enrollments'),
      );
      await expectLater(
        repo.setHalaqaActive('h:1', active: false),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.code,
            'code',
            'academic.halaqa_has_active_enrollments',
          ),
        ),
      );
    });
  });
}
