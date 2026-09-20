import 'data_origin.dart';

/// The learner's overall standing. Structure is real (30 ajzaa from
/// "مدينة الحفاظ", the three mutun, the five departments); numbers are mock.
class ProgressSummary implements Sourced {
  const ProgressSummary({
    required this.studentName,
    required this.currentProgramName,
    required this.memorisedJuz,
    required this.totalJuz,
    required this.attendanceRatio,
    required this.completedHalaqat,
    required this.totalHalaqat,
    required this.mutun,
    required this.recentActivity,
  });

  final String studentName;
  final String currentProgramName;

  /// Which ajzaa (1-30) are done. "مدينة الحفاظ / 30 جزء" — page 10.
  final List<int> memorisedJuz;
  final int totalJuz;

  final double attendanceRatio;
  final int completedHalaqat;

  /// 45 across the five departments, per page 6.
  final int totalHalaqat;

  /// The three mutun named on page 10.
  final List<MatnProgress> mutun;

  final List<ActivityEntry> recentActivity;

  @override
  DataOrigin get origin => DataOrigin.mock;

  double get juzRatio => memorisedJuz.length / totalJuz;
  double get halaqatRatio =>
      totalHalaqat == 0 ? 0 : completedHalaqat / totalHalaqat;
}

/// One of the three mutun from page 10: تحفة الأطفال، الجزرية، الشاطبية.
///
/// The names are real. The ratio and status are mock — and deliberately
/// expressed as a proportion rather than a line count, so the prototype never
/// puts a fabricated number of أبيات in front of the user.
class MatnProgress {
  const MatnProgress({
    required this.name,
    required this.ratio,
    required this.statusLabel,
    required this.started,
  });

  final String name;
  final double ratio;
  final String statusLabel;
  final bool started;
}

class ActivityEntry {
  const ActivityEntry({
    required this.title,
    required this.detail,
    required this.dateLabel,
    required this.kind,
  });

  final String title;
  final String detail;
  final String dateLabel;
  final ActivityKind kind;
}

enum ActivityKind { lesson, attendance, certificate, halaqa }
