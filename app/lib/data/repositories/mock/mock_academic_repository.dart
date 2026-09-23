import '../../../app/app_config.dart';
import '../../models/academic.dart';
import '../../models/data_origin.dart';
import '../../models/program.dart';
import '../../sources/profile_data.dart';
import '../repositories.dart';

/// [AcademicRepository] for the demo build: the institution's structure as
/// the profile states it — built from [ProfileData], exactly as the server
/// seeds it (backend/src/modules/academic/application/institution-structure.json;
/// test/academic/profile_structure_test.dart holds the two together).
///
///   * the five graded departments (page 6), each with one program named
///     after it and exactly the halaqat page 6 counts — 5, 10, 10, 10, 10;
///   * the three special sections (pages 7–9), with no programs: the profile
///     names none;
///   * the four accompanying programs (page 10), under one section named by
///     the page's heading, with no halaqat.
///
/// Its ids are the codes. It knows nobody: [me] is whatever it was built
/// with — nothing by default, because there is no signed-in person in the
/// demo, and a made-up one would be pretending.
class MockAcademicRepository implements AcademicRepository {
  MockAcademicRepository({this.mine = const MyAcademic()});

  /// What [me] answers — nothing, unless a test says otherwise.
  final MyAcademic mine;

  @override
  DataOrigin get origin => DataOrigin.profile;

  static Future<T> _delayed<T>(T value) =>
      Future<T>.delayed(AppConfig.fakeLatency, () => value);

  /// The code the accompanying programs' section carries on the server.
  static const accompanyingCode = 'accompanying';

  static final List<AcademicSection> _sections = _build();

  static List<AcademicSection> _build() {
    var order = 0;
    AcademicSection section(
      Program source,
      SectionKind kind, [
      List<AcademicProgram> programs = const [],
    ]) => AcademicSection(
      id: source.id,
      code: source.id,
      name: source.name,
      kind: kind,
      order: ++order,
      status: StructureStatus.active,
      programs: programs,
    );

    return [
      for (final department in ProfileData.departments)
        section(department, SectionKind.progressive, [
          AcademicProgram(
            id: '${department.id}-program',
            code: '${department.id}-program',
            sectionId: department.id,
            name: department.name,
            order: 1,
            status: StructureStatus.active,
            activeHalaqaCount: department.halaqatCount ?? 0,
          ),
        ]),
      for (final special in ProfileData.specialSections)
        section(special, SectionKind.special),
      AcademicSection(
        id: accompanyingCode,
        code: accompanyingCode,
        name: ProfileData.companionProgramsHeading,
        kind: SectionKind.accompanying,
        order: ++order,
        status: StructureStatus.active,
        programs: [
          for (final (index, companion)
              in ProfileData.companionPrograms.indexed)
            AcademicProgram(
              id: companion.id,
              code: companion.id,
              sectionId: accompanyingCode,
              name: companion.name,
              order: index + 1,
              status: StructureStatus.active,
              activeHalaqaCount: 0,
            ),
        ],
      ),
    ];
  }

  /// Halaqat are named by number only: the profile gives counts, not names.
  static List<AcademicHalaqa> _halaqatOf(AcademicProgram program) => [
    for (var n = 1; n <= program.activeHalaqaCount; n++)
      AcademicHalaqa(
        id: '${program.sectionId}-h$n',
        code: '${program.sectionId}-h$n',
        programId: program.id,
        name: 'الحلقة $n',
        order: n,
        status: StructureStatus.active,
      ),
  ];

  @override
  Future<List<AcademicSection>> catalogue() => _delayed(_sections);

  @override
  Future<AcademicProgramDetail?> program(String programId) {
    for (final section in _sections) {
      for (final program in section.programs) {
        if (program.id != programId) continue;
        return _delayed<AcademicProgramDetail?>(
          AcademicProgramDetail(
            program: program,
            section: _withoutPrograms(section),
            halaqat: _halaqatOf(program),
          ),
        );
      }
    }
    return _delayed<AcademicProgramDetail?>(null);
  }

  @override
  Future<AcademicHalaqaDetail?> halaqa(String halaqaId) {
    for (final section in _sections) {
      for (final program in section.programs) {
        for (final halaqa in _halaqatOf(program)) {
          if (halaqa.id != halaqaId) continue;
          return _delayed<AcademicHalaqaDetail?>(
            AcademicHalaqaDetail(
              halaqa: halaqa,
              program: AcademicRef(
                id: program.id,
                code: program.code,
                name: program.name,
                order: program.order,
                status: program.status,
              ),
              section: AcademicSectionRef(
                id: section.id,
                code: section.code,
                name: section.name,
                order: section.order,
                status: section.status,
                kind: section.kind,
              ),
            ),
          );
        }
      }
    }
    return _delayed<AcademicHalaqaDetail?>(null);
  }

  @override
  Future<MyAcademic> me() => _delayed(mine);

  static AcademicSection _withoutPrograms(AcademicSection section) =>
      AcademicSection(
        id: section.id,
        code: section.code,
        name: section.name,
        kind: section.kind,
        order: section.order,
        status: section.status,
        description: section.description,
      );
}
