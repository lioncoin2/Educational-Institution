/// The administration's views over many tasks (ADR 0052 §8–§12): templates,
/// the operation log, the statistics dashboard and the export file.
library;

import 'task_vocabulary.dart';
import 'tasks_wire.dart';

/// A saved task configuration the owner re-publishes from.
class TaskTemplate {
  const TaskTemplate({
    required this.id,
    required this.title,
    required this.body,
    required this.kind,
    required this.buttons,
    required this.reportRequired,
    required this.approvalMode,
    required this.audiences,
    required this.communityId,
    required this.createdAt,
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
  final DateTime createdAt;

  factory TaskTemplate.fromJson(Map<String, Object?> json) => TaskTemplate(
    id: TasksWire.string(json, 'id'),
    title: TasksWire.string(json, 'title'),
    body: TasksWire.text(json, 'body'),
    kind: TaskKind.fromWire(json['kind']),
    buttons: TasksWire.strings(json['buttons']).map(TaskButton.fromWire).toList(growable: false),
    reportRequired: TasksWire.flag(json, 'reportRequired'),
    approvalMode: ApprovalMode.fromWire(json['approvalMode']),
    audiences: TasksWire.strings(json['audiences']).map(TaskAudience.fromWire).toList(growable: false),
    communityId: TasksWire.optionalString(json['communityId']),
    createdAt: TasksWire.instant(json, 'createdAt'),
  );
}

/// One act in a task's operation log — who did what, when (ids, never text).
class TaskLogEntry {
  const TaskLogEntry({
    required this.sequence,
    required this.action,
    required this.actor,
    required this.occurredAt,
    required this.detail,
  });

  final int sequence;

  /// The server's action code (`TASK_PUBLISHED`, `REPORT_APPROVED`, …).
  final String action;

  /// Null for the system (an automatic archive or approval).
  final PersonRef? actor;
  final DateTime occurredAt;
  final Map<String, Object?> detail;

  factory TaskLogEntry.fromJson(Map<String, Object?> json) => TaskLogEntry(
    sequence: TasksWire.integer(json, 'sequence'),
    action: TasksWire.string(json, 'action'),
    actor: PersonRef.maybe(json['actor']),
    occurredAt: TasksWire.instant(json, 'occurredAt'),
    detail: json['detail'] is Map ? (json['detail']! as Map).cast<String, Object?>() : const {},
  );
}

/// Counts over a set of assignments, with the two rates (null over nobody).
class TaskTotals {
  const TaskTotals({
    required this.tasks,
    required this.tasksArchived,
    required this.assignments,
    required this.responded,
    required this.completed,
    required this.reportsApproved,
    required this.reportsChangesRequested,
    required this.reportsPending,
    required this.acknowledgementRate,
    required this.completionRate,
  });

  final int tasks;
  final int tasksArchived;
  final int assignments;
  final int responded;
  final int completed;
  final int reportsApproved;
  final int reportsChangesRequested;
  final int reportsPending;

  /// Percent, one decimal; null when there was nobody to answer.
  final double? acknowledgementRate;
  final double? completionRate;

  int get notCompleted => assignments - completed;

  factory TaskTotals.fromJson(Map<String, Object?> json) {
    int read(String key) => TasksWire.optionalInteger(json[key]) ?? 0;
    return TaskTotals(
      tasks: read('tasks'),
      tasksArchived: read('tasksArchived'),
      assignments: read('assignments'),
      responded: read('responded'),
      completed: read('completed'),
      reportsApproved: read('reportsApproved'),
      reportsChangesRequested: read('reportsChangesRequested'),
      reportsPending: read('reportsPending'),
      acknowledgementRate: TasksWire.optionalNumber(json['acknowledgementRate']),
      completionRate: TasksWire.optionalNumber(json['completionRate']),
    );
  }
}

/// Totals for one group of the dashboard: an audience, a community, a person.
class TaskTotalsGroup {
  const TaskTotalsGroup({required this.key, required this.label, required this.totals});

  /// The audience wire value, community id or person id.
  final String key;

  /// A person's name when known; null for audiences and communities (the
  /// screen labels those).
  final String? label;
  final TaskTotals totals;
}

/// The statistics dashboard (roadmap §12) — never a ranking: people come
/// alphabetically by id.
class TaskDashboard {
  const TaskDashboard({
    required this.totals,
    required this.byAudience,
    required this.byCommunity,
    required this.byPerson,
  });

  final TaskTotals totals;
  final List<TaskTotalsGroup> byAudience;
  final List<TaskTotalsGroup> byCommunity;
  final List<TaskTotalsGroup> byPerson;

  factory TaskDashboard.fromJson(Map<String, Object?> json) => TaskDashboard(
    totals: TaskTotals.fromJson(TasksWire.map(json['totals'])),
    byAudience: TasksWire.list(
      json['byAudience'],
      (row) => TaskTotalsGroup(
        key: TasksWire.string(row, 'audience'),
        label: null,
        totals: TaskTotals.fromJson(row),
      ),
    ),
    byCommunity: TasksWire.list(
      json['byCommunity'],
      (row) => TaskTotalsGroup(
        key: TasksWire.string(row, 'communityId'),
        label: null,
        totals: TaskTotals.fromJson(row),
      ),
    ),
    byPerson: TasksWire.list(json['byPerson'], (row) {
      final person = PersonRef.fromJson(row['person']);
      return TaskTotalsGroup(key: person.id, label: person.name, totals: TaskTotals.fromJson(row));
    }),
  );
}

/// A generated export, as downloaded.
class TaskExportFile {
  const TaskExportFile({
    required this.format,
    required this.bytes,
    required this.fileName,
    required this.truncated,
  });

  final TaskExportFormat format;
  final List<int> bytes;
  final String fileName;

  /// The server stopped at its row limit; narrow the filters for the rest.
  final bool truncated;
}
