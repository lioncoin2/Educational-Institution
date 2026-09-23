import '../../models/academic.dart';
import '../../models/data_origin.dart';
import '../../models/learning.dart';
import '../repositories.dart';

/// [LearningRepository] over the server's academic records — مساري and the
/// halaqat screens, against real data.
///
/// It shows what is recorded and nothing else:
///
///   * the ladder is the PROGRESSIVE sections in order, with their ACTIVE
///     halaqat counted; the learner's place on it is where they are enrolled
///     now ([ProgressState.current]). Every other rung is [ProgressState.none]:
///     completion and prerequisites are not modelled, so no rung is shown as
///     done, open or locked;
///   * no progress: [PathStep.completedHalaqat] is null, a halaqa has no
///     lessons and no attendance — none are recorded yet, so no percentage
///     is ever computed;
///   * a halaqa's teachers are named only for the learner's own halaqat, as
///     the server tells a student; nobody's classmates, ever;
///   * a halaqa is found by the server's id; a program by its route id —
///     a section's code, or an accompanying program's.
class AcademicLearningRepository implements LearningRepository {
  AcademicLearningRepository(this._academic);

  final AcademicRepository _academic;

  Future<List<AcademicSection>>? _catalogueInflight;
  Future<MyAcademic>? _meInflight;

  /// Concurrent callers share one request; the next caller asks again.
  Future<List<AcademicSection>> _catalogue() => _catalogueInflight ??= _academic
      .catalogue()
      .whenComplete(() => _catalogueInflight = null);

  Future<MyAcademic> _me() =>
      _meInflight ??= _academic.me().whenComplete(() => _meInflight = null);

  /// Both at once. `Future.wait` rethrows the first failure as it was thrown
  /// — an [AcademicException] stays one, so a screen can tell "sign in" from
  /// "try again".
  Future<(List<AcademicSection>, MyAcademic)> _catalogueAndMe() async {
    final results = await Future.wait<Object>([_catalogue(), _me()]);
    return (results[0] as List<AcademicSection>, results[1] as MyAcademic);
  }

  @override
  Future<List<PathStep>> getPath() async {
    final (sections, mine) = await _catalogueAndMe();
    final enrolledIn = {
      for (final entry in mine.activeEnrollments) entry.placement.section.code,
    };
    final ladder = [
      for (final section in sections)
        if (section.kind == SectionKind.progressive &&
            (section.isActive || enrolledIn.contains(section.code)))
          section,
    ];
    return [
      for (final (index, section) in ladder.indexed)
        PathStep(
          programId: section.code,
          name: section.name,
          order: index + 1,
          halaqatCount: section.activeHalaqaCount,
          state: enrolledIn.contains(section.code)
              ? ProgressState.current
              : ProgressState.none,
          completedHalaqat: null,
          origin: DataOrigin.records,
        ),
    ];
  }

  @override
  Future<List<Halaqa>> getHalaqat(String programId) async {
    final (sections, mine) = await _catalogueAndMe();
    final enrolled = _enrolledHalaqat(mine);
    final enrolledPrograms = {
      for (final entry in enrolled.values) entry.placement.program.id,
    };
    final programs = [
      for (final program in _programsFor(programId, sections))
        if (program.isActive || enrolledPrograms.contains(program.id)) program,
    ];
    if (programs.isEmpty) return const [];
    final details = await Future.wait([
      for (final program in programs) _academic.program(program.id),
    ]);
    return [
      for (final detail in details)
        if (detail != null)
          for (final halaqa in detail.halaqat)
            // What is inactive — the halaqa, its program or its section — is
            // not offered; the learner's own halaqa still shows.
            if ((detail.section.isActive &&
                    detail.program.isActive &&
                    halaqa.isActive) ||
                enrolled.containsKey(halaqa.id))
              _halaqa(
                halaqa.id,
                halaqa.name,
                halaqa.order,
                programId,
                enrolled[halaqa.id],
              ),
    ];
  }

  @override
  Future<Halaqa?> getHalaqa(String halaqaId) async {
    final results = await Future.wait<Object?>([
      _academic.halaqa(halaqaId),
      _me(),
    ]);
    final detail = results[0] as AcademicHalaqaDetail?;
    final mine = results[1]! as MyAcademic;
    if (detail == null) return null;
    final routeId = detail.section.kind == SectionKind.accompanying
        ? detail.program.code
        : detail.section.code;
    return _halaqa(
      detail.halaqa.id,
      detail.halaqa.name,
      detail.halaqa.order,
      routeId,
      _enrolledHalaqat(mine)[detail.halaqa.id],
    );
  }

  /// No lessons are recorded: there is nothing to open.
  @override
  Future<Lesson?> getLesson(String halaqaId, String lessonId) async => null;

  /// The learner's most recent current enrollment on the graded ladder.
  @override
  Future<Halaqa?> getCurrentHalaqa() async {
    final mine = await _me();
    final onLadder =
        [
          for (final entry in mine.activeEnrollments)
            if (entry.placement.section.kind == SectionKind.progressive) entry,
        ]..sort(
          (a, b) => b.enrollment.enrolledAt.compareTo(a.enrollment.enrolledAt),
        );
    if (onLadder.isEmpty) return null;
    final current = onLadder.first;
    return _halaqa(
      current.placement.halaqa.id,
      current.placement.halaqa.name,
      current.placement.halaqa.order,
      current.placement.section.code,
      current,
    );
  }

  /// The programs behind a route id: a section's, or one accompanying program.
  static List<AcademicProgram> _programsFor(
    String routeId,
    List<AcademicSection> sections,
  ) {
    for (final section in sections) {
      if (section.kind == SectionKind.accompanying) {
        for (final program in section.programs) {
          if (program.code == routeId) return [program];
        }
      } else if (section.code == routeId &&
          section.kind != SectionKind.unknown) {
        return section.programs;
      }
    }
    return const [];
  }

  static Map<String, MyEnrollment> _enrolledHalaqat(MyAcademic mine) => {
    for (final entry in mine.activeEnrollments)
      entry.placement.halaqa.id: entry,
  };

  /// [enrollment] is the learner's own ACTIVE one in it, if any.
  static Halaqa _halaqa(
    String id,
    String name,
    int order,
    String routeId,
    MyEnrollment? enrollment,
  ) {
    return Halaqa(
      id: id,
      programId: routeId,
      name: name,
      index: order,
      state: enrollment == null ? ProgressState.none : ProgressState.current,
      teacherName: enrollment == null ? null : _teachers(enrollment),
      origin: DataOrigin.records,
    );
  }

  /// "Who teaches my halaqa", by display name — null when nobody is assigned
  /// (or no name is known).
  static String? _teachers(MyEnrollment enrollment) {
    final names = [
      for (final teacher in enrollment.teachers) ?teacher.displayName,
    ];
    return names.isEmpty ? null : names.join('، ');
  }
}
