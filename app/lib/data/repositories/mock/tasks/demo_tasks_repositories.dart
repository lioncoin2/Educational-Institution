import '../../../models/tasks/tasks.dart';
import '../../contracts/tasks_repositories.dart';

/// The demo (no backend) has no tasks engine: the engine's records — who was
/// addressed, who answered, which report was approved — only mean something on
/// the server. Rather than invent them, every call refuses with
/// `tasks.demo_unavailable`, and the screens say the feature needs the server.
/// The demo's signed-in student holds no tasks permission, so these are reached
/// only by a direct link.
const demoUnavailable = TasksException(
  'tasks.demo_unavailable',
  'The tasks engine needs a connection to the institution server.',
);

Future<T> _refuse<T>() => Future<T>.error(demoUnavailable);

class DemoMyTasksRepository implements MyTasksRepository {
  const DemoMyTasksRepository();

  @override
  Future<TasksPage<MyTask>> myTasks({required MyTasksScope scope, String? cursor}) => _refuse();
  @override
  Future<MyTaskDetail> myTask(String assignmentId) => _refuse();
  @override
  Future<MyTaskDetail> myTaskByTask(String taskId) => _refuse();
  @override
  Future<TaskAssignment> acknowledge(String assignmentId) => _refuse();
  @override
  Future<TaskAssignment> complete(String assignmentId, {String? report}) => _refuse();
  @override
  Future<TaskReport> writeReport(String assignmentId, {required int version, required String body}) =>
      _refuse();
}

class DemoTaskAdministrationRepository implements TaskAdministrationRepository {
  const DemoTaskAdministrationRepository();

  @override
  Future<TaskItem> publish(TaskDraft draft, {required String clientRequestId}) => _refuse();
  @override
  Future<TasksPage<TaskOverview>> tasks({TaskFilter filter = TaskFilter.none, String? cursor}) =>
      _refuse();
  @override
  Future<TaskDetail> task(String taskId) => _refuse();
  @override
  Future<TaskItem> edit(String taskId, TaskEdit edit) => _refuse();
  @override
  Future<TaskItem> cancel(String taskId) => _refuse();
  @override
  Future<TaskItem> reopen(String taskId) => _refuse();
  @override
  Future<int> remindNonResponders(String taskId) => _refuse();
  @override
  Future<TasksPage<TrackingRow>> tracking(
    String taskId, {
    TrackingFilter filter = TrackingFilter.all,
    String? cursor,
  }) => _refuse();
  @override
  Future<TaskAssignment> reassign(String taskId, String assignmentId, {required String toUserId}) =>
      _refuse();
  @override
  Future<TasksPage<TaskLogEntry>> history(String taskId, {String? cursor}) => _refuse();
  @override
  Future<TaskItem> republish(String taskId, TaskDraft draft, {required String clientRequestId}) =>
      _refuse();
  @override
  Future<TasksPage<TaskTemplate>> templates({String? cursor}) => _refuse();
  @override
  Future<TaskTemplate> saveTemplateFromTask(String taskId) => _refuse();
  @override
  Future<TaskTemplate> saveTemplateFromDraft(TaskDraft draft) => _refuse();
  @override
  Future<void> deleteTemplate(String templateId) => _refuse();
}

class DemoTaskReportsRepository implements TaskReportsRepository {
  const DemoTaskReportsRepository();

  @override
  Future<TasksPage<ReportSummary>> reports({
    TaskFilter filter = TaskFilter.none,
    ReportCategory? category,
    String? cursor,
  }) => _refuse();
  @override
  Future<ReportDetail> report(String reportId) => _refuse();
  @override
  Future<TaskReport> review(
    String reportId, {
    required int version,
    required ReviewDecision decision,
    String? note,
  }) => _refuse();
  @override
  Future<TaskReport> edit(String reportId, {required int version, required String body}) =>
      _refuse();
  @override
  Future<TaskReport> delete(String reportId) => _refuse();
}

class DemoTaskInsightsRepository implements TaskInsightsRepository {
  const DemoTaskInsightsRepository();

  @override
  Future<TaskDashboard> dashboard({TaskFilter filter = TaskFilter.none}) => _refuse();
  @override
  Future<TaskExportFile> export({
    TaskFilter filter = TaskFilter.none,
    required TaskExportFormat format,
  }) => _refuse();
}
