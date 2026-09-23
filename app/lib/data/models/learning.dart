import 'data_origin.dart';

/// Where the learner stands on a step of the ladder.
///
/// [none] says nothing at all: the learner has no relationship with the step
/// that is recorded — neither done, nor open to them, nor closed. It is what
/// real records show for every step but the ones the learner is enrolled in,
/// because completion and prerequisites are not modelled (and not invented).
enum ProgressState { completed, current, available, locked, none }

/// One rung of the graded path — a department from page 6 plus the learner's
/// position on it. The rung itself is real; in the demo the position is mock,
/// against the server it is the learner's actual enrollment.
class PathStep implements Sourced {
  const PathStep({
    required this.programId,
    required this.name,
    required this.order,
    required this.halaqatCount,
    required this.state,
    required this.completedHalaqat,
    this.origin = DataOrigin.mock,
  });

  final String programId;
  final String name;
  final int order;

  /// From page 6, or the server's count of ACTIVE halaqat — real.
  final int halaqatCount;

  final ProgressState state;

  /// Null when no progress is recorded — then no progress is shown.
  final int? completedHalaqat;

  /// Of the position: mock in the demo, records against the server.
  @override
  final DataOrigin origin;

  double? get ratio {
    final done = completedHalaqat;
    if (done == null) return null;
    return halaqatCount == 0 ? 0 : (done / halaqatCount).clamp(0.0, 1.0);
  }
}

/// A حلقة — the unit the institution actually organises teaching around.
///
/// In the demo, the *number* of halaqat per department is from the profile
/// and an individual halaqa's name, teacher and schedule are invented.
/// Against the server ([DataOrigin.records]) a halaqa is what the records
/// hold: its name, its position, whether the learner is enrolled in it and,
/// for their own halaqat, who teaches it. What is not recorded — a schedule,
/// lessons, attendance — is null or empty, and is not shown.
class Halaqa implements Sourced {
  const Halaqa({
    required this.id,
    required this.programId,
    required this.name,
    required this.index,
    required this.state,
    this.teacherName,
    this.scheduleLabel,
    this.groupChannelLabel,
    this.lessons = const [],
    this.attendedSessions = 0,
    this.totalSessions = 0,
    this.origin = DataOrigin.mock,
  });

  final String id;

  /// The route id of the program it belongs to.
  final String programId;
  final String name;

  /// 1-based position inside its department.
  final int index;

  /// Null when unknown to the viewer.
  final String? teacherName;
  final String? scheduleLabel;

  /// The profile says teaching runs through WhatsApp / Telegram groups (p11);
  /// this label stands in for that link. Tapping it does not open anything.
  final String? groupChannelLabel;

  final List<Lesson> lessons;
  final int attendedSessions;
  final int totalSessions;
  final ProgressState state;

  @override
  final DataOrigin origin;

  /// Whether lessons or attendance are recorded for it at all.
  bool get hasProgress => lessons.isNotEmpty || totalSessions > 0;

  int get completedLessons =>
      lessons.where((l) => l.state == LessonState.completed).length;

  double get ratio =>
      lessons.isEmpty ? 0 : completedLessons / lessons.length;

  double get attendanceRatio =>
      totalSessions == 0 ? 0 : attendedSessions / totalSessions;
}

enum LessonState { completed, current, locked }

/// A single lesson inside a halaqa. Entirely mock — the profile does not
/// describe lesson-level content.
class Lesson implements Sourced {
  const Lesson({
    required this.id,
    required this.halaqaId,
    required this.order,
    required this.title,
    required this.summary,
    required this.durationLabel,
    required this.state,
    required this.objectives,
    required this.passageLabel,
    this.passageText,
  });

  final String id;
  final String halaqaId;
  final int order;
  final String title;
  final String summary;
  final String durationLabel;
  final LessonState state;
  final List<String> objectives;

  /// e.g. "سورة الفاتحة — الآيات 1 إلى 7".
  final String passageLabel;

  /// Optional Arabic line rendered in the Quranic face.
  final String? passageText;

  @override
  DataOrigin get origin => DataOrigin.mock;
}
