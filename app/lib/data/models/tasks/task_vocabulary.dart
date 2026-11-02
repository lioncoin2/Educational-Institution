/// The closed vocabularies of the daily tasks engine (ADR 0052), each with its
/// wire value and an `unknown` fallback so a newer server never breaks parsing.
library;

/// Who a task is published to.
enum TaskAudience {
  teachers('TEACHERS'),
  supervisors('SUPERVISORS'),
  administration('ADMINISTRATION'),
  unknown('UNKNOWN');

  const TaskAudience(this.wire);
  final String wire;

  static const selectable = [teachers, supervisors, administration];

  static TaskAudience fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// The interactive buttons a task may offer its recipients.
enum TaskButton {
  acknowledge('ACKNOWLEDGE'),
  complete('COMPLETE'),
  unknown('UNKNOWN');

  const TaskButton(this.wire);
  final String wire;

  static const selectable = [acknowledge, complete];

  static TaskButton fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// What a task is about; decides the category its reports are filed under.
enum TaskKind {
  general('GENERAL'),
  attendance('ATTENDANCE'),
  teaching('TEACHING'),
  unknown('UNKNOWN');

  const TaskKind(this.wire);
  final String wire;

  static const selectable = [general, attendance, teaching];

  static TaskKind fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// Whether a submitted report is approved at once or waits for a reviewer.
enum ApprovalMode {
  auto('AUTO'),
  manual('MANUAL'),
  unknown('UNKNOWN');

  const ApprovalMode(this.wire);
  final String wire;

  static const selectable = [manual, auto];

  static ApprovalMode fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// Where a task stands, as lists show it.
enum TaskState {
  active('ACTIVE'),
  archived('ARCHIVED'),
  cancelled('CANCELLED'),
  unknown('UNKNOWN');

  const TaskState(this.wire);
  final String wire;

  static const selectable = [active, archived, cancelled];

  static TaskState fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// One recipient's progress on one task.
enum AssignmentStatus {
  pending('PENDING'),
  acknowledged('ACKNOWLEDGED'),
  completed('COMPLETED'),
  reassigned('REASSIGNED'),
  unknown('UNKNOWN');

  const AssignmentStatus(this.wire);
  final String wire;

  static AssignmentStatus fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// A report's review state.
enum ReportStatus {
  pendingReview('PENDING_REVIEW'),
  approved('APPROVED'),
  changesRequested('CHANGES_REQUESTED'),
  deleted('DELETED'),
  unknown('UNKNOWN');

  const ReportStatus(this.wire);
  final String wire;

  static const selectable = [pendingReview, approved, changesRequested];

  static ReportStatus fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// The category a report is filed under — derived from the task's kind by the
/// server, never chosen by the author.
enum ReportCategory {
  taskCompletion('TASK_COMPLETION'),
  attendance('ATTENDANCE'),
  teachers('TEACHERS'),
  unknown('UNKNOWN');

  const ReportCategory(this.wire);
  final String wire;

  static const selectable = [taskCompletion, attendance, teachers];

  static ReportCategory fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// A reviewer's decision on one report version.
enum ReviewDecision {
  approved('APPROVED'),
  changesRequested('CHANGES_REQUESTED'),
  unknown('UNKNOWN');

  const ReviewDecision(this.wire);
  final String wire;

  static ReviewDecision fromWire(Object? value) =>
      values.firstWhere((v) => v.wire == value, orElse: () => unknown);
}

/// The follow-up page's filters over a task's recipients.
enum TrackingFilter {
  all('ALL'),
  responded('RESPONDED'),
  notResponded('NOT_RESPONDED'),
  completed('COMPLETED'),
  notCompleted('NOT_COMPLETED');

  const TrackingFilter(this.wire);
  final String wire;
}

/// A recipient's own lists: still to do, or done.
enum MyTasksScope {
  open('OPEN'),
  done('DONE');

  const MyTasksScope(this.wire);
  final String wire;
}

/// The export formats: CSV (opens in Excel) or the print-ready HTML report
/// (the browser saves it as PDF).
enum TaskExportFormat {
  csv('csv'),
  html('html');

  const TaskExportFormat(this.wire);
  final String wire;
}
