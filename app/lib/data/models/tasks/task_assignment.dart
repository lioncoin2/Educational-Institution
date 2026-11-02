/// A task as it reaches one recipient (ADR 0052 §5): their assignment, the
/// follow-up row the administration sees, and the recipient's own view.
library;

import 'task.dart';
import 'task_report.dart';
import 'task_vocabulary.dart';
import 'tasks_wire.dart';

class TaskAssignment {
  const TaskAssignment({
    required this.id,
    required this.taskId,
    required this.status,
    required this.audience,
    required this.acknowledgedAt,
    required this.completedAt,
    required this.createdAt,
    required this.reassignedAt,
    required this.replaces,
    required this.reassignedTo,
  });

  final String id;
  final String taskId;
  final AssignmentStatus status;
  final TaskAudience audience;
  final DateTime? acknowledgedAt;
  final DateTime? completedAt;

  /// When the task reached this recipient.
  final DateTime createdAt;
  final DateTime? reassignedAt;

  /// The assignment this one took over, when it came by reassignment.
  final String? replaces;
  final String? reassignedTo;

  bool get isPending => status == AssignmentStatus.pending;
  bool get isAcknowledged => status == AssignmentStatus.acknowledged;
  bool get isCompleted => status == AssignmentStatus.completed;
  bool get isReassigned => status == AssignmentStatus.reassigned;
  bool get hasResponded => acknowledgedAt != null || completedAt != null;

  factory TaskAssignment.fromJson(Map<String, Object?> json) => TaskAssignment(
    id: TasksWire.string(json, 'id'),
    taskId: TasksWire.string(json, 'taskId'),
    status: AssignmentStatus.fromWire(json['status']),
    audience: TaskAudience.fromWire(json['audience']),
    acknowledgedAt: TasksWire.optionalInstant(json['acknowledgedAt']),
    completedAt: TasksWire.optionalInstant(json['completedAt']),
    createdAt: TasksWire.instant(json, 'createdAt'),
    reassignedAt: TasksWire.optionalInstant(json['reassignedAt']),
    replaces: TasksWire.optionalString(json['replaces']),
    reassignedTo: TasksWire.optionalString(json['reassignedTo']),
  );
}

/// A report's state as the follow-up page lists it.
class TrackedReport {
  const TrackedReport({required this.id, required this.status, required this.version});

  final String id;
  final ReportStatus status;
  final int version;

  static TrackedReport? maybe(Object? raw) {
    if (raw is! Map) return null;
    final json = raw.cast<String, Object?>();
    return TrackedReport(
      id: TasksWire.string(json, 'id'),
      status: ReportStatus.fromWire(json['status']),
      version: TasksWire.integer(json, 'version'),
    );
  }
}

/// One recipient on a task's follow-up page (roadmap §4).
class TrackingRow {
  const TrackingRow({
    required this.assignment,
    required this.recipient,
    required this.reassignedBy,
    required this.report,
  });

  final TaskAssignment assignment;
  final PersonRef recipient;
  final PersonRef? reassignedBy;
  final TrackedReport? report;

  factory TrackingRow.fromJson(Map<String, Object?> json) => TrackingRow(
    assignment: TaskAssignment.fromJson(json),
    recipient: PersonRef.fromJson(json['recipient']),
    reassignedBy: PersonRef.maybe(json['reassignedBy']),
    report: TrackedReport.maybe(json['report']),
  );
}

/// One of the signed-in recipient's tasks.
class MyTask {
  const MyTask({required this.assignment, required this.task, required this.report});

  final TaskAssignment assignment;
  final TaskItem task;
  final TaskReport? report;

  factory MyTask.fromJson(Map<String, Object?> json) => MyTask(
    assignment: TaskAssignment.fromJson(TasksWire.map(json['assignment'])),
    task: TaskItem.fromJson(TasksWire.map(json['task'])),
    report: json['report'] == null ? null : TaskReport.fromJson(TasksWire.map(json['report'])),
  );
}

/// The recipient's page for one task: plus their latest report text and the
/// reviewers' notes on it.
class MyTaskDetail {
  const MyTaskDetail({required this.item, required this.latest, required this.reviews});

  final MyTask item;
  final ReportVersion? latest;
  final List<ReportReview> reviews;

  TaskAssignment get assignment => item.assignment;
  TaskItem get task => item.task;
  TaskReport? get report => item.report;

  factory MyTaskDetail.fromJson(Map<String, Object?> json) => MyTaskDetail(
    item: MyTask.fromJson(json),
    latest: json['latest'] == null ? null : ReportVersion.fromJson(TasksWire.map(json['latest'])),
    reviews: TasksWire.list(json['reviews'], ReportReview.fromJson),
  );
}
