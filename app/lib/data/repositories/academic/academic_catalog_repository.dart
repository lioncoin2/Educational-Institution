import '../../models/academic.dart';
import '../../models/program.dart';
import '../../sources/profile_data.dart';
import '../repositories.dart';

/// [CatalogRepository] over [AcademicRepository] — the screens' `Program`s,
/// filled from the academic structure: the demo's (built from the profile)
/// or the server's.
///
///   * a PROGRESSIVE section is a department, and a SPECIAL one a special
///     section, each keyed by its code; an ACCOMPANYING section's programs
///     are the companion programs, keyed by theirs;
///   * a department's halaqat are its ACTIVE programs' ACTIVE halaqat;
///   * names, order and counts come from the structure. What the structure
///     does not hold — the profile's descriptions, items, badges, levels and
///     capacity notes — comes from [ProfileData], matched by code, and is
///     marked with its page. A description the institution has written for
///     itself replaces the profile's, and then no page is claimed;
///   * the lists hold what is ACTIVE — what is offered. [getProgram] also
///     finds what is not, so an old link still opens.
class AcademicCatalogRepository implements CatalogRepository {
  AcademicCatalogRepository(this._academic);

  final AcademicRepository _academic;

  /// One request serves every list asked for at once (home asks for three).
  Future<List<AcademicSection>>? _inflight;

  Future<List<AcademicSection>> _catalogue() =>
      _inflight ??= _academic.catalogue().whenComplete(() => _inflight = null);

  static final Map<String, Program> _profile = {
    for (final program in ProfileData.allPrograms) program.id: program,
  };

  @override
  Future<List<Program>> getDepartments() async => [
    for (final section in await _catalogue())
      if (section.kind == SectionKind.progressive && section.isActive)
        _fromSection(section, ProgramKind.department),
  ];

  @override
  Future<List<Program>> getSpecialSections() async => [
    for (final section in await _catalogue())
      if (section.kind == SectionKind.special && section.isActive)
        _fromSection(section, ProgramKind.special),
  ];

  @override
  Future<List<Program>> getCompanionPrograms() async => [
    for (final section in await _catalogue())
      if (section.kind == SectionKind.accompanying && section.isActive)
        for (final program in section.programs)
          if (program.isActive) _fromProgram(program),
  ];

  @override
  Future<Program?> getProgram(String id) async {
    for (final section in await _catalogue()) {
      switch (section.kind) {
        case SectionKind.progressive when section.code == id:
          return _fromSection(section, ProgramKind.department);
        case SectionKind.special when section.code == id:
          return _fromSection(section, ProgramKind.special);
        case SectionKind.accompanying:
          for (final program in section.programs) {
            if (program.code == id) return _fromProgram(program);
          }
        case _:
          continue;
      }
    }
    return null;
  }

  Program _fromSection(AcademicSection section, ProgramKind kind) => _program(
    code: section.code,
    name: section.name,
    kind: kind,
    order: section.order,
    halaqat: section.activeHalaqaCount,
    description: section.description,
  );

  Program _fromProgram(AcademicProgram program) => _program(
    code: program.code,
    name: program.name,
    kind: ProgramKind.companion,
    order: program.order,
    halaqat: program.isActive ? program.activeHalaqaCount : 0,
    description: program.description,
  );

  Program _program({
    required String code,
    required String name,
    required ProgramKind kind,
    required int order,
    required int halaqat,
    required String? description,
  }) {
    final profile = _profile[code];
    return Program(
      id: code,
      name: name,
      kind: kind,
      // A position on the graded ladder: only departments have one.
      order: kind == ProgramKind.department ? order : 0,
      halaqatCount: halaqat > 0 ? halaqat : null,
      description: description ?? profile?.description,
      sourcePage: description == null ? profile?.sourcePage : null,
      badge: profile?.badge,
      items: profile?.items ?? const [],
      levelsCount: profile?.levelsCount,
      capacityNote: profile?.capacityNote,
      iconName: profile?.iconName ?? 'book',
      origin: _academic.origin,
    );
  }
}
