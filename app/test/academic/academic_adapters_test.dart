import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/learning.dart';
import 'package:quran_institution_app/data/models/program.dart';
import 'package:quran_institution_app/data/repositories/academic/academic_catalog_repository.dart';
import 'package:quran_institution_app/data/repositories/academic/academic_learning_repository.dart';
import 'package:quran_institution_app/data/repositories/academic/academic_profile_repositories.dart';
import 'package:quran_institution_app/data/repositories/http/http_academic_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_auth_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_academic_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/data/sources/profile_data.dart';

import 'academic_test_support.dart';

/// Counts how often the structure is asked for.
class CountingAcademic implements AcademicRepository {
  CountingAcademic(this.inner);

  final AcademicRepository inner;
  int catalogueCalls = 0;
  int meCalls = 0;

  @override
  DataOrigin get origin => inner.origin;

  @override
  Future<List<AcademicSection>> catalogue() {
    catalogueCalls++;
    return inner.catalogue();
  }

  @override
  Future<AcademicProgramDetail?> program(String programId) =>
      inner.program(programId);

  @override
  Future<AcademicHalaqaDetail?> halaqa(String halaqaId) =>
      inner.halaqa(halaqaId);

  @override
  Future<MyAcademic> me() {
    meCalls++;
    return inner.me();
  }
}

void main() {
  late AcademicServer server;
  late InMemoryTokenStore tokens;
  late ApiClient api;

  setUp(() async {
    server = AcademicServer();
    tokens = InMemoryTokenStore();
    await tokens.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
    api = ApiClient(
      baseUri: Uri.parse('https://api.test/'),
      httpClient: server.client,
      tokenStore: tokens,
    );
  });

  String describe(Program p) =>
      '${p.id}|${p.name}|${p.kind}|${p.order}|${p.halaqatCount}|${p.badge}|'
      '${p.description}|${p.items}|${p.levelsCount}|${p.capacityNote}|'
      '${p.iconName}|${p.sourcePage}';

  group('the catalogue, read through the academic repository', () {
    test('in the demo, is exactly the profile — field for field', () async {
      final catalog = AcademicCatalogRepository(MockAcademicRepository());
      expect(
        (await catalog.getDepartments()).map(describe),
        ProfileData.departments.map(describe),
      );
      expect(
        (await catalog.getSpecialSections()).map(describe),
        ProfileData.specialSections.map(describe),
      );
      expect(
        (await catalog.getCompanionPrograms()).map(describe),
        ProfileData.companionPrograms.map(describe),
      );
      for (final program in ProfileData.allPrograms) {
        expect(
          describe((await catalog.getProgram(program.id))!),
          describe(program),
        );
      }
      expect((await catalog.getDepartments()).first.origin, DataOrigin.profile);
    });

    test(
      'against the server, takes names and counts from its records',
      () async {
        final literacy = server.section('dep-literacy');
        literacy['name'] = 'قسم محو الأمية للكبار';
        final program = (literacy['programs']! as List)
            .cast<Map<String, Object?>>()
            .single;
        program['activeHalaqaCount'] = 4;
        final catalog = AcademicCatalogRepository(HttpAcademicRepository(api));
        final [first, ...] = await catalog.getDepartments();
        expect(first.name, 'قسم محو الأمية للكبار');
        expect(first.halaqatCount, 4);
        expect(first.origin, DataOrigin.records);
        // …and the profile's own text, by code, where the records hold none.
        final kids = (await catalog.getProgram('sec-kids'))!;
        expect(kids.description, ProfileData.specialSections[1].description);
        expect(kids.sourcePage, 8);
        expect(kids.levelsCount, 3);
        expect(
          kids.halaqatCount,
          isNull,
          reason: 'no halaqat recorded is not "0 حلقات"',
        );
      },
    );

    test('shows a description the institution wrote — and then claims no page for it', () async {
      server.section('sec-languages')['description'] =
          'وصف كتبته إدارة المؤسسة';
      final catalog = AcademicCatalogRepository(HttpAcademicRepository(api));
      final languages = (await catalog.getProgram('sec-languages'))!;
      expect(languages.description, 'وصف كتبته إدارة المؤسسة');
      expect(languages.sourcePage, isNull);
    });

    test('lists what is offered — and still opens what is not', () async {
      server.section('dep-tajweed-3')['status'] = 'INACTIVE';
      server.section('accompanying')['programs'] = [
        for (final p
            in (server.section('accompanying')['programs']! as List)
                .cast<Map<String, Object?>>())
          {...p, if (p['code'] == 'prog-nahw') 'status': 'INACTIVE'},
      ];
      server.sections.add({
        ...server.section('sec-kids'),
        'id': 's:future',
        'code': 'future',
        'kind': 'SOMETHING_NEW',
      });
      final catalog = AcademicCatalogRepository(HttpAcademicRepository(api));
      expect(
        (await catalog.getDepartments()).map((p) => p.id),
        isNot(contains('dep-tajweed-3')),
      );
      expect((await catalog.getCompanionPrograms()).map((p) => p.id), [
        'prog-hifz-city',
        'prog-maqari',
        'prog-mutun',
      ]);
      expect(
        (await catalog.getProgram('dep-tajweed-3'))?.name,
        'قسم تجويد متقدم',
      );
      expect(await catalog.getProgram('future'), isNull);
      expect(await catalog.getProgram('dep-tajweed-3-program'), isNull);
    });

    test('asks once for everything home asks for at once', () async {
      final counting = CountingAcademic(HttpAcademicRepository(api));
      final catalog = AcademicCatalogRepository(counting);
      await Future.wait([
        catalog.getDepartments(),
        catalog.getSpecialSections(),
        catalog.getCompanionPrograms(),
      ]);
      expect(counting.catalogueCalls, 1);
      await catalog.getDepartments(); // a later ask is a fresh one
      expect(counting.catalogueCalls, 2);
    });
  });

  group('learning, against the server’s records', () {
    late AcademicLearningRepository learning;

    setUp(() {
      learning = AcademicLearningRepository(HttpAcademicRepository(api));
    });

    test('puts the learner where they are enrolled — and nowhere else, with no progress', () async {
      server.enroll('h:dep-tajweed-2-h3');
      final path = await learning.getPath();
      expect(path.map((s) => s.programId), [
        'dep-literacy',
        'dep-letters',
        'dep-tajweed-1',
        'dep-tajweed-2',
        'dep-tajweed-3',
      ]);
      expect(path.map((s) => s.state), [
        ProgressState.none,
        ProgressState.none,
        ProgressState.none,
        ProgressState.current,
        ProgressState.none,
      ]);
      expect(path.map((s) => s.halaqatCount), [5, 10, 10, 10, 10]);
      expect(
        path.every((s) => s.completedHalaqat == null && s.ratio == null),
        isTrue,
      );
      expect(path.every((s) => s.origin == DataOrigin.records), isTrue);
    });

    test('lists a department’s halaqat, marks the learner’s own and names its teachers', () async {
      server.enroll(
        'h:dep-tajweed-2-h3',
        teachers: [
          {'userId': 't1', 'displayName': 'الأستاذة عائشة', 'role': 'TEACHER'},
          {
            'userId': 't2',
            'displayName': 'المساعدة خديجة',
            'role': 'ASSISTANT_TEACHER',
          },
          {'userId': 'gone', 'displayName': null, 'role': 'TEACHER'},
        ],
      );
      final halaqat = await learning.getHalaqat('dep-tajweed-2');
      expect(halaqat.map((h) => h.name), [
        for (var n = 1; n <= 10; n++) 'الحلقة $n',
      ]);
      final mine = halaqat.singleWhere((h) => h.state == ProgressState.current);
      expect(mine.id, 'h:dep-tajweed-2-h3');
      expect(mine.programId, 'dep-tajweed-2');
      expect(mine.teacherName, 'الأستاذة عائشة، المساعدة خديجة');
      expect(
        halaqat
            .where((h) => h != mine)
            .every(
              (h) => h.state == ProgressState.none && h.teacherName == null,
            ),
        isTrue,
      );
      expect(
        halaqat.every(
          (h) =>
              h.lessons.isEmpty &&
              !h.hasProgress &&
              h.scheduleLabel == null &&
              h.groupChannelLabel == null &&
              h.origin == DataOrigin.records,
        ),
        isTrue,
      );
    });

    test(
      'offers only what is open — but keeps the learner’s own halaqa in view',
      () async {
        final halaqat = server.halaqatOf['p:dep-letters-program']!;
        halaqat[0]['status'] = 'INACTIVE';
        halaqat[1]['status'] = 'INACTIVE';
        server.enroll('h:dep-letters-h2');
        final listed = await learning.getHalaqat('dep-letters');
        expect(listed.map((h) => h.id), isNot(contains('h:dep-letters-h1')));
        expect(listed.map((h) => h.id), contains('h:dep-letters-h2'));
        expect(listed, hasLength(9));
      },
    );

    test(
      'has no halaqat where the records hold none, and none for an unknown id',
      () async {
        expect(await learning.getHalaqat('sec-kids'), isEmpty);
        expect(await learning.getHalaqat('prog-nahw'), isEmpty);
        expect(await learning.getHalaqat('no-such-program'), isEmpty);
      },
    );

    test(
      'opens one halaqa by the server’s id, under the route of where it sits',
      () async {
        final halaqa = (await learning.getHalaqa('h:dep-literacy-h5'))!;
        expect(
          (halaqa.name, halaqa.programId, halaqa.index),
          ('الحلقة 5', 'dep-literacy', 5),
        );
        expect(halaqa.state, ProgressState.none);
        expect(await learning.getHalaqa('nope'), isNull);
        expect(await learning.getLesson('h:dep-literacy-h5', 'l1'), isNull);
      },
    );

    test('surfaces the most recent current enrollment on the ladder', () async {
      expect(await learning.getCurrentHalaqa(), isNull);
      server.enroll('h:dep-letters-h1', enrolledAt: '2026-08-01T08:00:00.000Z');
      server.enroll(
        'h:dep-tajweed-1-h7',
        enrolledAt: '2026-09-02T08:00:00.000Z',
      );
      server.enroll('h:dep-literacy-h1', status: 'COMPLETED');
      final current = (await learning.getCurrentHalaqa())!;
      expect(current.id, 'h:dep-tajweed-1-h7');
      expect(current.state, ProgressState.current);
    });

    test('asks for the structure and the record once per question', () async {
      final counting = CountingAcademic(HttpAcademicRepository(api));
      final shared = AcademicLearningRepository(counting);
      await Future.wait([shared.getPath(), shared.getHalaqat('dep-literacy')]);
      expect((counting.catalogueCalls, counting.meCalls), (1, 1));
    });

    test('keeps a refusal what it is — a sign-in stays a sign-in', () async {
      await tokens.clear();
      await expectLater(
        learning.getPath(),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.needsSignIn,
            'sign-in',
            isTrue,
          ),
        ),
      );
    });
  });

  group('the person, against the server', () {
    test(
      'is the signed-in account and where they study — nothing invented',
      () async {
        server.enroll('h:dep-tajweed-2-h3');
        final institution = AcademicInstitutionRepository(
          HttpAcademicRepository(api),
          HttpAuthRepository(api),
        );
        final student = await institution.getStudent();
        expect(student.name, 'مريم');
        expect(student.initials, 'م');
        expect(student.currentProgramName, 'قسم تجويد متوسط');
        expect(student.currentProgramId, 'dep-tajweed-2');
        expect(student.targetGroupName, isNull);
        expect(student.joinedLabel, isNull);
        expect(student.origin, DataOrigin.records);
        expect(
          await institution.getInstitution(),
          same(ProfileData.institution),
        );
      },
    );

    test('is nobody when nobody is signed in', () async {
      await tokens.clear();
      final institution = AcademicInstitutionRepository(
        HttpAcademicRepository(api),
        HttpAuthRepository(api),
      );
      await expectLater(
        institution.getStudent(),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.needsSignIn,
            'sign-in',
            isTrue,
          ),
        ),
      );
    });

    test('has no progress: none is recorded, so none is made up', () async {
      expect(await const UnrecordedProgressRepository().getProgress(), isNull);
    });
  });
}
