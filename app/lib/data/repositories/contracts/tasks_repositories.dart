/// The daily tasks & reports engine's repository contracts (ADR 0052).
///
/// Four narrow seams, one per audience of the API: the recipient's own tasks,
/// the administration's task lifecycle, the reports under review, and the
/// statistics/export. The server authorizes every call (`tasks.respond`,
/// `tasks.manage`, `tasks.template`); the app's gates are only a courtesy. A
/// refusal throws a [TasksException] carrying the server's code — nothing is
/// fabricated.
library;

import '../../models/tasks/tasks.dart';

/// `/my-tasks` — a recipient's tasks and their responses to them.
abstract interface class MyTasksRepository {
  Future<TasksPage<MyTask>> myTasks({required MyTasksScope scope, String? cursor});

  Future<MyTaskDetail> myTask(String assignmentId);

  /// The signed-in recipient's current assignment of a task (a notification
  /// names the task, not the assignment).
  Future<MyTaskDetail> myTaskByTask(String taskId);

  Future<TaskAssignment> acknowledge(String assignmentId);

  /// Completes the assignment, with the report text when the task asks for one.
  Future<TaskAssignment> complete(String assignmentId, {String? report});

  /// Rewrites the recipient's own report; [version] is the one being replaced.
  Future<TaskReport> writeReport(String assignmentId, {required int version, required String body});
}

/// `/tasks` and `/task-templates` — publishing and running tasks.
abstract interface class TaskAdministrationRepository {
  /// [clientRequestId] makes a retried publish land once.
  Future<TaskItem> publish(TaskDraft draft, {required String clientRequestId});

  Future<TasksPage<TaskOverview>> tasks({TaskFilter filter = TaskFilter.none, String? cursor});

  Future<TaskDetail> task(String taskId);

  Future<TaskItem> edit(String taskId, TaskEdit edit);

  Future<TaskItem> cancel(String taskId);

  Future<TaskItem> reopen(String taskId);

  /// Reminds only those who have not responded at all; answers how many.
  Future<int> remindNonResponders(String taskId);

  Future<TasksPage<TrackingRow>> tracking(
    String taskId, {
    TrackingFilter filter = TrackingFilter.all,
    String? cursor,
  });

  Future<TaskAssignment> reassign(String taskId, String assignmentId, {required String toUserId});

  Future<TasksPage<TaskLogEntry>> history(String taskId, {String? cursor});

  /// A new, independent task from a past one, with [draft]'s content (owner only).
  Future<TaskItem> republish(String taskId, TaskDraft draft, {required String clientRequestId});

  Future<TasksPage<TaskTemplate>> templates({String? cursor});

  /// Saves a template from an existing task (owner only).
  Future<TaskTemplate> saveTemplateFromTask(String taskId);

  /// Saves a template from a configuration typed in the composer (owner only).
  Future<TaskTemplate> saveTemplateFromDraft(TaskDraft draft);

  Future<void> deleteTemplate(String templateId);
}

/// `/task-reports` — the reports page and its review.
abstract interface class TaskReportsRepository {
  Future<TasksPage<ReportSummary>> reports({
    TaskFilter filter = TaskFilter.none,
    ReportCategory? category,
    String? cursor,
  });

  Future<ReportDetail> report(String reportId);

  /// Decides the report's [version]; a request for changes needs a [note].
  Future<TaskReport> review(
    String reportId, {
    required int version,
    required ReviewDecision decision,
    String? note,
  });

  Future<TaskReport> edit(String reportId, {required int version, required String body});

  Future<TaskReport> delete(String reportId);
}

/// `/task-dashboard` — statistics and the export, over the common filters.
abstract interface class TaskInsightsRepository {
  Future<TaskDashboard> dashboard({TaskFilter filter = TaskFilter.none});

  Future<TaskExportFile> export({
    TaskFilter filter = TaskFilter.none,
    required TaskExportFormat format,
  });
}
