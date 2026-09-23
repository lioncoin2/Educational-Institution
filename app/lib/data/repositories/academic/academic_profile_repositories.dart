import '../../models/academic.dart';
import '../../models/data_origin.dart';
import '../../models/institution.dart';
import '../../models/progress.dart';
import '../../models/student.dart';
import '../../sources/profile_data.dart';
import '../repositories.dart';

/// [InstitutionRepository] against the server: the institution is described
/// by its profile (the server does not keep that text), and the person is the
/// signed-in account with its academic record — nothing about them that the
/// record does not hold (no target group, no "joined 8 months ago").
class AcademicInstitutionRepository implements InstitutionRepository {
  AcademicInstitutionRepository(this._academic, this._auth);

  final AcademicRepository _academic;
  final AuthRepository _auth;

  @override
  Future<Institution> getInstitution() async => ProfileData.institution;

  /// Throws [AcademicException] (`identity.authentication_required`) when
  /// nobody is signed in: there is no one to describe.
  @override
  Future<StudentProfile> getStudent() async {
    final user = await _auth.currentUser();
    if (user == null) {
      throw const AcademicException(
        'identity.authentication_required',
        'Nobody is signed in.',
      );
    }
    final current = _mostRecent((await _academic.me()).activeEnrollments);
    final name = user.displayName.trim();
    return StudentProfile(
      name: name,
      initials: name.isEmpty ? '' : String.fromCharCode(name.runes.first),
      currentProgramId: current == null ? null : _routeId(current.placement),
      currentProgramName: current?.placement.section.name,
      origin: DataOrigin.records,
    );
  }

  static MyEnrollment? _mostRecent(List<MyEnrollment> enrollments) {
    MyEnrollment? latest;
    for (final entry in enrollments) {
      if (latest == null ||
          entry.enrollment.enrolledAt.isAfter(latest.enrollment.enrolledAt)) {
        latest = entry;
      }
    }
    return latest;
  }

  /// The id the app's routes know the placement's program by.
  static String _routeId(AcademicPlacement placement) =>
      placement.section.kind == SectionKind.accompanying
      ? placement.program.code
      : placement.section.code;
}

/// [ProgressRepository] against the server: no lesson, attendance or
/// memorisation progress is recorded there yet, so there is none to show —
/// and none is made up.
class UnrecordedProgressRepository implements ProgressRepository {
  const UnrecordedProgressRepository();

  @override
  Future<ProgressSummary?> getProgress() async => null;
}
