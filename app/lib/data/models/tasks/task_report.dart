/// A recipient's text report on a task, with its versions and reviews
/// (ADR 0052 §4–§6).
library;

import 'task.dart';
import 'task_vocabulary.dart';
import 'tasks_wire.dart';

class TaskReport {
  const TaskReport({
    required this.id,
    required this.taskId,
    required this.assignmentId,
    required this.author,
    required this.category,
    required this.status,
    required this.version,
    required this.submittedAt,
    required this.updatedAt,
    required this.approvedAt,
    required this.approvedBy,
    required this.deletedAt,
  });

  final String id;
  final String taskId;
  final String assignmentId;
  final PersonRef author;
  final ReportCategory category;
  final ReportStatus status;

  /// The current version — the one a review or an edit must quote.
  final int version;
  final DateTime submittedAt;
  final DateTime updatedAt;
  final DateTime? approvedAt;

  /// Null with an [approvedAt]: approved automatically.
  final PersonRef? approvedBy;
  final DateTime? deletedAt;

  bool get isPendingReview => status == ReportStatus.pendingReview;
  bool get isDeleted => status == ReportStatus.deleted;

  factory TaskReport.fromJson(Map<String, Object?> json) => TaskReport(
    id: TasksWire.string(json, 'id'),
    taskId: TasksWire.string(json, 'taskId'),
    assignmentId: TasksWire.string(json, 'assignmentId'),
    author: PersonRef.fromJson(json['author']),
    category: ReportCategory.fromWire(json['category']),
    status: ReportStatus.fromWire(json['status']),
    version: TasksWire.integer(json, 'version'),
    submittedAt: TasksWire.instant(json, 'submittedAt'),
    updatedAt: TasksWire.instant(json, 'updatedAt'),
    approvedAt: TasksWire.optionalInstant(json['approvedAt']),
    approvedBy: PersonRef.maybe(json['approvedBy']),
    deletedAt: TasksWire.optionalInstant(json['deletedAt']),
  );
}

/// A report in the reports page, with the task it answers.
class ReportSummary {
  const ReportSummary({
    required this.report,
    required this.taskTitle,
    required this.taskKind,
    required this.audience,
  });

  final TaskReport report;
  final String taskTitle;
  final TaskKind taskKind;
  final TaskAudience audience;

  factory ReportSummary.fromJson(Map<String, Object?> json) => ReportSummary(
    report: TaskReport.fromJson(json),
    taskTitle: TasksWire.string(json, 'taskTitle'),
    taskKind: TaskKind.fromWire(json['taskKind']),
    audience: TaskAudience.fromWire(json['audience']),
  );
}

/// One kept version of a report's text.
class ReportVersion {
  const ReportVersion({
    required this.version,
    required this.body,
    required this.editedBy,
    required this.editedAt,
  });

  final int version;
  final String body;
  final PersonRef editedBy;
  final DateTime editedAt;

  factory ReportVersion.fromJson(Map<String, Object?> json) => ReportVersion(
    version: TasksWire.integer(json, 'version'),
    body: TasksWire.text(json, 'body'),
    editedBy: PersonRef.fromJson(json['editedBy']),
    editedAt: TasksWire.instant(json, 'editedAt'),
  );
}

/// One review decision, on the version it judged.
class ReportReview {
  const ReportReview({
    required this.version,
    required this.decision,
    required this.note,
    required this.reviewer,
    required this.decidedAt,
  });

  final int version;
  final ReviewDecision decision;
  final String? note;
  final PersonRef reviewer;
  final DateTime decidedAt;

  factory ReportReview.fromJson(Map<String, Object?> json) => ReportReview(
    version: TasksWire.integer(json, 'version'),
    decision: ReviewDecision.fromWire(json['decision']),
    note: TasksWire.optionalString(json['note']),
    reviewer: PersonRef.fromJson(json['reviewer']),
    decidedAt: TasksWire.instant(json, 'decidedAt'),
  );
}

/// A report's page for a reviewer: the report, its task, every version and review.
class ReportDetail {
  const ReportDetail({
    required this.report,
    required this.task,
    required this.versions,
    required this.reviews,
  });

  final TaskReport report;
  final TaskItem task;
  final List<ReportVersion> versions;
  final List<ReportReview> reviews;

  ReportVersion? get latest => versions.isEmpty ? null : versions.last;

  factory ReportDetail.fromJson(Map<String, Object?> json) => ReportDetail(
    report: TaskReport.fromJson(TasksWire.map(json['report'])),
    task: TaskItem.fromJson(TasksWire.map(json['task'])),
    versions: TasksWire.list(json['versions'], ReportVersion.fromJson),
    reviews: TasksWire.list(json['reviews'], ReportReview.fromJson),
  );
}
