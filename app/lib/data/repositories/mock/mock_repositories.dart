import '../../../app/app_config.dart';
import '../../models/certificate.dart';
import '../../models/feed.dart';
import '../../models/institution.dart';
import '../../models/learning.dart';
import '../../models/progress.dart';
import '../../models/student.dart';
import '../../sources/mock_data.dart';
import '../../sources/profile_data.dart';
import '../repositories.dart';

/// In-memory implementations backed by [ProfileData] (real) and [MockData]
/// (placeholder). No network, no storage, no side effects. The catalogue is
/// not here: in the demo it is read through `MockAcademicRepository`, the
/// same way it is read from the server.
Future<T> _delayed<T>(T value) =>
    Future<T>.delayed(AppConfig.fakeLatency, () => value);

class MockInstitutionRepository implements InstitutionRepository {
  const MockInstitutionRepository();

  @override
  Future<Institution> getInstitution() => _delayed(ProfileData.institution);

  @override
  Future<StudentProfile> getStudent() => _delayed(MockData.student);
}

class MockLearningRepository implements LearningRepository {
  const MockLearningRepository();

  @override
  Future<List<PathStep>> getPath() => _delayed(MockData.pathSteps());

  @override
  Future<List<Halaqa>> getHalaqat(String programId) {
    for (final p in ProfileData.allPrograms) {
      if (p.id == programId) return _delayed(MockData.halaqatFor(p));
    }
    return _delayed(const <Halaqa>[]);
  }

  @override
  Future<Halaqa?> getHalaqa(String halaqaId) =>
      _delayed(MockData.halaqaById(halaqaId));

  @override
  Future<Lesson?> getLesson(String halaqaId, String lessonId) =>
      _delayed(MockData.lessonById(halaqaId, lessonId));

  @override
  Future<Halaqa?> getCurrentHalaqa() => _delayed(MockData.currentHalaqa());
}

class MockProgressRepository implements ProgressRepository {
  const MockProgressRepository();

  @override
  Future<ProgressSummary?> getProgress() =>
      _delayed<ProgressSummary?>(MockData.progress());
}

class MockCertificateRepository implements CertificateRepository {
  const MockCertificateRepository();

  @override
  Future<List<Certificate>> getCertificates() =>
      _delayed(MockData.certificates());

  @override
  Future<Certificate?> getCertificate(String id) =>
      _delayed(MockData.certificateById(id));
}

class MockFeedRepository implements FeedRepository {
  const MockFeedRepository();

  @override
  Future<List<Announcement>> getAnnouncements() =>
      _delayed(MockData.announcements());
}
