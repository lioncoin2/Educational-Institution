import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_academic_repository.dart';
import 'package:quran_institution_app/data/sources/profile_data.dart';

import 'academic_test_support.dart';

/// ONE source of the institution's structure: the backend seeds from
/// backend/src/modules/academic/application/institution-structure.json, and
/// the app's own transcription of the profile — [ProfileData], and the demo's
/// [MockAcademicRepository] built from it — is held to that file here. If
/// either side changes alone, this fails, so the two cannot drift apart.
void main() {
  final structure = canonicalStructure();
  final sections = [
    for (final s in structure['sections']! as List<Object?>)
      (s! as Map).cast<String, Object?>(),
  ];
  List<Map<String, Object?>> ofKind(String kind) =>
      sections.where((s) => s['kind'] == kind).toList();
  List<Map<String, Object?>> programsOf(Map<String, Object?> section) => [
    for (final p in section['programs']! as List<Object?>)
      (p! as Map).cast<String, Object?>(),
  ];

  test(
    'the five graded departments: codes, names, order, page and halaqat',
    () {
      final progressive = ofKind('PROGRESSIVE');
      expect(
        [
          for (final d in ProfileData.departments)
            (d.id, d.name, d.order, d.sourcePage),
        ],
        [
          for (final s in progressive)
            (s['code'], s['name'], s['order'], s['sourcePage']),
        ],
      );
      expect(
        [for (final d in ProfileData.departments) d.halaqatCount],
        [for (final s in progressive) programsOf(s).single['halaqat']],
      );
      expect(ProfileData.totalHalaqat, 45);
    },
  );

  test(
    'the three special sections, with no programs the profile does not name',
    () {
      final special = ofKind('SPECIAL');
      expect(
        [
          for (final s in ProfileData.specialSections)
            (s.id, s.name, s.sourcePage),
        ],
        [for (final s in special) (s['code'], s['name'], s['sourcePage'])],
      );
      expect(special.every((s) => programsOf(s).isEmpty), isTrue);
    },
  );

  test('the four accompanying programs under the page-10 heading', () {
    final [accompanying] = ofKind('ACCOMPANYING');
    expect(accompanying['name'], ProfileData.companionProgramsHeading);
    expect(accompanying['sourcePage'], 10);
    expect(
      [for (final p in ProfileData.companionPrograms) (p.id, p.name)],
      [for (final p in programsOf(accompanying)) (p['code'], p['name'])],
    );
    expect(programsOf(accompanying).every((p) => p['halaqat'] == 0), isTrue);
  });

  test(
    'the demo repository is exactly that structure — halaqat named by number',
    () async {
      final demo = MockAcademicRepository();
      final catalogue = await demo.catalogue();
      expect(
        [for (final s in catalogue) (s.code, s.name, s.kind.wire, s.order)],
        [
          for (final s in sections)
            (s['code'], s['name'], s['kind'], s['order']),
        ],
      );
      for (final (section, source) in [
        for (var i = 0; i < sections.length; i++) (catalogue[i], sections[i]),
      ]) {
        expect(
          [
            for (final p in section.programs)
              (p.code, p.name, p.order, p.activeHalaqaCount),
          ],
          [
            for (final p in programsOf(source))
              (p['code'], p['name'], p['order'], p['halaqat']),
          ],
        );
        for (final program in section.programs) {
          final detail = await demo.program(program.id);
          expect(
            [for (final h in detail!.halaqat) (h.code, h.name, h.order)],
            [
              for (var n = 1; n <= program.activeHalaqaCount; n++)
                ('${section.code}-h$n', 'الحلقة $n', n),
            ],
          );
        }
      }
      expect(
        catalogue.every((s) => s.status == StructureStatus.active),
        isTrue,
      );
    },
  );
}
