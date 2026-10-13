import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_academic_repository.dart';

/// The demo build mirrors the printed profile's structure, read-only. It is
/// never reached by a manager (the demo account is a student with no
/// `academic.manage`), so every structure write refuses honestly with
/// `academic.unsupported_in_demo` rather than pretending to persist.
void main() {
  late MockAcademicRepository repo;

  setUp(() => repo = MockAcademicRepository());

  test('still reads the demo structure', () async {
    expect(repo.origin, DataOrigin.profile);
    expect(await repo.catalogue(), isNotEmpty);
  });

  Matcher throwsUnsupported() => throwsA(
    isA<AcademicException>().having(
      (e) => e.code,
      'code',
      'academic.unsupported_in_demo',
    ),
  );

  test('refuses every write — it never fakes a mutation', () async {
    await expectLater(
      repo.createSection(
        code: 'c',
        name: 'n',
        order: 1,
        kind: SectionKind.special,
      ),
      throwsUnsupported(),
    );
    await expectLater(
      repo.updateSection('s', name: 'n', order: 1),
      throwsUnsupported(),
    );
    await expectLater(
      repo.setSectionActive('s', active: false),
      throwsUnsupported(),
    );
    await expectLater(
      repo.createProgram(sectionId: 's', code: 'c', name: 'n', order: 1),
      throwsUnsupported(),
    );
    await expectLater(
      repo.updateProgram('p', name: 'n', order: 1),
      throwsUnsupported(),
    );
    await expectLater(
      repo.setProgramActive('p', active: true),
      throwsUnsupported(),
    );
    await expectLater(
      repo.createHalaqa(programId: 'p', code: 'c', name: 'n', order: 1),
      throwsUnsupported(),
    );
    await expectLater(
      repo.updateHalaqa('h', name: 'n', order: 1),
      throwsUnsupported(),
    );
    await expectLater(
      repo.setHalaqaActive('h', active: false),
      throwsUnsupported(),
    );
  });
}
