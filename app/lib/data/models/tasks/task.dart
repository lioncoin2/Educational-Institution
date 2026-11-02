/// A published task as the administration sees it (ADR 0052 §3–§7): the task,
/// its response counts, and its edit history.
library;

import 'task_vocabulary.dart';
import 'tasks_wire.dart';

class TaskItem {
  const TaskItem({
    required this.id,
    required this.title,
    required this.body,
    required this.kind,
    required this.buttons,
    required this.reportRequired,
    required this.approvalMode,
    required this.audiences,
    required this.communityId,
    required this.revision,
    required this.state,
    required this.createdBy,
    required this.createdAt,
    required this.updatedAt,
    required this.cancelledAt,
    required this.archivedAt,
    required this.templateId,
    required this.republishedFrom,
  });

  final String id;
  final String title;
  final String body;
  final TaskKind kind;
  final List<TaskButton> buttons;
  final bool reportRequired;
  final ApprovalMode approvalMode;
  final List<TaskAudience> audiences;
  final String? communityId;

  /// The edit counter an edit must quote (optimistic concurrency).
  final int revision;
  final TaskState state;
  final String createdBy;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? cancelledAt;
  final DateTime? archivedAt;
  final String? templateId;
  final String? republishedFrom;

  bool get isActive => state == TaskState.active;
  bool get isCancelled => state == TaskState.cancelled;
  bool get offersAcknowledge => buttons.contains(TaskButton.acknowledge);
  bool get offersComplete => buttons.contains(TaskButton.complete);

  factory TaskItem.fromJson(Map<String, Object?> json) => TaskItem(
    id: TasksWire.string(json, 'id'),
    title: TasksWire.string(json, 'title'),
    body: TasksWire.text(json, 'body'),
    kind: TaskKind.fromWire(json['kind']),
    buttons: TasksWire.strings(json['buttons']).map(TaskButton.fromWire).toList(growable: false),
    reportRequired: TasksWire.flag(json, 'reportRequired'),
    approvalMode: ApprovalMode.fromWire(json['approvalMode']),
    audiences: TasksWire.strings(json['audiences']).map(TaskAudience.fromWire).toList(growable: false),
    communityId: TasksWire.optionalString(json['communityId']),
    revision: TasksWire.integer(json, 'revision'),
    state: TaskState.fromWire(json['state']),
    createdBy: TasksWire.string(json, 'createdBy'),
    createdAt: TasksWire.instant(json, 'createdAt'),
    updatedAt: TasksWire.instant(json, 'updatedAt'),
    cancelledAt: TasksWire.optionalInstant(json['cancelledAt']),
    archivedAt: TasksWire.optionalInstant(json['archivedAt']),
    templateId: TasksWire.optionalString(json['templateId']),
    republishedFrom: TasksWire.optionalString(json['republishedFrom']),
  );
}

/// How a task's recipients have answered so far.
class TaskCounts {
  const TaskCounts({
    required this.targets,
    required this.responded,
    required this.completed,
    required this.reportsPending,
    required this.reportsApproved,
    required this.reportsChangesRequested,
  });

  static const empty = TaskCounts(
    targets: 0,
    responded: 0,
    completed: 0,
    reportsPending: 0,
    reportsApproved: 0,
    reportsChangesRequested: 0,
  );

  /// Current (not reassigned-away) recipients.
  final int targets;
  final int responded;
  final int completed;
  final int reportsPending;
  final int reportsApproved;
  final int reportsChangesRequested;

  int get notResponded => targets - responded;

  factory TaskCounts.fromJson(Object? raw) {
    if (raw is! Map) return empty;
    final json = raw.cast<String, Object?>();
    int read(String key) => TasksWire.optionalInteger(json[key]) ?? 0;
    return TaskCounts(
      targets: read('targets'),
      responded: read('responded'),
      completed: read('completed'),
      reportsPending: read('reportsPending'),
      reportsApproved: read('reportsApproved'),
      reportsChangesRequested: read('reportsChangesRequested'),
    );
  }
}

/// A task in the administration's list.
class TaskOverview {
  const TaskOverview({required this.task, required this.counts});

  final TaskItem task;
  final TaskCounts counts;

  factory TaskOverview.fromJson(Map<String, Object?> json) => TaskOverview(
    task: TaskItem.fromJson(TasksWire.map(json['task'])),
    counts: TaskCounts.fromJson(json['counts']),
  );
}

/// One saved state of a task's content and settings.
class TaskRevision {
  const TaskRevision({
    required this.revision,
    required this.title,
    required this.body,
    required this.editedBy,
    required this.editedAt,
    required this.requireReacknowledge,
  });

  final int revision;
  final String title;
  final String body;
  final PersonRef editedBy;
  final DateTime editedAt;
  final bool requireReacknowledge;

  factory TaskRevision.fromJson(Map<String, Object?> json) => TaskRevision(
    revision: TasksWire.integer(json, 'revision'),
    title: TasksWire.string(json, 'title'),
    body: TasksWire.text(json, 'body'),
    editedBy: PersonRef.fromJson(json['editedBy']),
    editedAt: TasksWire.instant(json, 'editedAt'),
    requireReacknowledge: TasksWire.flag(json, 'requireReacknowledge'),
  );
}

/// One task's page: the task, its counts, who made and cancelled it, its revisions.
class TaskDetail {
  const TaskDetail({
    required this.task,
    required this.counts,
    required this.createdBy,
    required this.cancelledBy,
    required this.revisions,
  });

  final TaskItem task;
  final TaskCounts counts;
  final PersonRef createdBy;
  final PersonRef? cancelledBy;
  final List<TaskRevision> revisions;

  factory TaskDetail.fromJson(Map<String, Object?> json) => TaskDetail(
    task: TaskItem.fromJson(TasksWire.map(json['task'])),
    counts: TaskCounts.fromJson(json['counts']),
    createdBy: PersonRef.fromJson(json['createdBy']),
    cancelledBy: PersonRef.maybe(json['cancelledBy']),
    revisions: TasksWire.list(json['revisions'], TaskRevision.fromJson),
  );
}
