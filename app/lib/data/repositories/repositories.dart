import '../models/certificate.dart';
import '../models/feed.dart';
import '../models/institution.dart';
import '../models/learning.dart';
import '../models/progress.dart';
import '../models/program.dart';
import '../models/student.dart';

/// Repository contracts.
///
/// Screens depend only on these interfaces. Swapping the prototype's in-memory
/// implementations for real network-backed ones means writing new classes that
/// implement these same contracts — no screen changes.

abstract interface class InstitutionRepository {
  Future<Institution> getInstitution();
  Future<StudentProfile> getStudent();
}

abstract interface class CatalogRepository {
  /// The five graded departments (profile page 6).
  Future<List<Program>> getDepartments();

  /// التهجي، البراعم، اللغات (pages 7–9).
  Future<List<Program>> getSpecialSections();

  /// البرامج المرافقة (page 10).
  Future<List<Program>> getCompanionPrograms();

  Future<Program?> getProgram(String id);
}

abstract interface class LearningRepository {
  /// The learner's position along the graded ladder.
  Future<List<PathStep>> getPath();

  /// Halaqat belonging to a program.
  Future<List<Halaqa>> getHalaqat(String programId);

  Future<Halaqa?> getHalaqa(String halaqaId);

  Future<Lesson?> getLesson(String halaqaId, String lessonId);

  /// The halaqa surfaced on the home screen.
  Future<Halaqa?> getCurrentHalaqa();
}

abstract interface class ProgressRepository {
  Future<ProgressSummary> getProgress();
}

abstract interface class CertificateRepository {
  Future<List<Certificate>> getCertificates();
  Future<Certificate?> getCertificate(String id);
}

abstract interface class FeedRepository {
  Future<List<Announcement>> getAnnouncements();
  Future<List<AppNotification>> getNotifications();
}
