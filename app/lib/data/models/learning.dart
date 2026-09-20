import 'data_origin.dart';

/// Where the learner stands on a step of the ladder.
enum ProgressState { completed, current, available, locked }

/// One rung of the graded path — a department from page 6 plus the learner's
/// position on it. The rung itself is real; the position is mock.
class PathStep {
  const PathStep({
    required this.programId,
    required this.name,
    required this.order,
    required this.halaqatCount,
    required this.state,
    required this.completedHalaqat,
  });

  final String programId;
  final String name;
  final int order;

  /// From page 6 — real.
  final int halaqatCount;

  /// Mock.
  final ProgressState state;

  /// Mock.
  final int completedHalaqat;

  double get ratio =>
      halaqatCount == 0 ? 0 : (completedHalaqat / halaqatCount).clamp(0.0, 1.0);
}

/// A حلقة — the unit the institution actually organises teaching around.
///
/// The *number* of halaqat per department is from the profile; an individual
/// halaqa's name, teacher and schedule are invented for the prototype.
class Halaqa implements Sourced {
  const Halaqa({
    required this.id,
    required this.programId,
    required this.name,
    required this.index,
    required this.teacherName,
    required this.scheduleLabel,
    required this.groupChannelLabel,
    required this.lessons,
    required this.attendedSessions,
    required this.totalSessions,
    required this.state,
  });

  final String id;
  final String programId;
  final String name;

  /// 1-based position inside its department.
  final int index;

  final String teacherName;
  final String scheduleLabel;

  /// The profile says teaching runs through WhatsApp / Telegram groups (p11);
  /// this label stands in for that link. Tapping it does not open anything.
  final String groupChannelLabel;

  final List<Lesson> lessons;
  final int attendedSessions;
  final int totalSessions;
  final ProgressState state;

  @override
  DataOrigin get origin => DataOrigin.mock;

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
