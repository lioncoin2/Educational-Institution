import '../../../api/api_client.dart';
import '../../../models/tasks/tasks.dart';
import '../../contracts/tasks_repositories.dart';
import 'tasks_http.dart';

/// Talks to `/tasks` and `/task-templates` (ADR 0052 §3–§8): publishing,
/// editing, following up and re-publishing tasks.
class HttpTaskAdministrationRepository implements TaskAdministrationRepository {
  HttpTaskAdministrationRepository(this._api);

  final ApiClient _api;

  String _task(String taskId) => '/tasks/${TasksHttp.segment(taskId)}';

  @override
  Future<TaskItem> publish(TaskDraft draft, {required String clientRequestId}) => TasksHttp.call(
    () async => TaskItem.fromJson(
      await _api.post('/tasks', body: {...draft.toJson(), 'clientRequestId': clientRequestId}),
    ),
  );

  @override
  Future<TasksPage<TaskOverview>> tasks({TaskFilter filter = TaskFilter.none, String? cursor}) =>
      TasksHttp.call(() async {
        final json = await _api.get(
          '/tasks',
          query: TasksHttp.query({...filter.toQuery(), 'cursor': cursor}),
        );
        return TasksWire.page(json, TaskOverview.fromJson);
      });

  @override
  Future<TaskDetail> task(String taskId) =>
      TasksHttp.call(() async => TaskDetail.fromJson(await _api.get(_task(taskId))));

  @override
  Future<TaskItem> edit(String taskId, TaskEdit edit) => TasksHttp.call(
    () async => TaskItem.fromJson(await _api.patch(_task(taskId), body: edit.toJson())),
  );

  @override
  Future<TaskItem> cancel(String taskId) =>
      TasksHttp.call(() async => TaskItem.fromJson(await _api.post('${_task(taskId)}/cancel')));

  @override
  Future<TaskItem> reopen(String taskId) =>
      TasksHttp.call(() async => TaskItem.fromJson(await _api.post('${_task(taskId)}/reopen')));

  @override
  Future<int> remindNonResponders(String taskId) => TasksHttp.call(() async {
    final json = await _api.post('${_task(taskId)}/remind');
    return TasksWire.integer(json, 'reminded');
  });

  @override
  Future<TasksPage<TrackingRow>> tracking(
    String taskId, {
    TrackingFilter filter = TrackingFilter.all,
    String? cursor,
  }) => TasksHttp.call(() async {
    final json = await _api.get(
      '${_task(taskId)}/assignments',
      query: TasksHttp.query({'filter': filter.wire, 'cursor': cursor}),
    );
    return TasksWire.page(json, TrackingRow.fromJson);
  });

  @override
  Future<TaskAssignment> reassign(
    String taskId,
    String assignmentId, {
    required String toUserId,
  }) => TasksHttp.call(
    () async => TaskAssignment.fromJson(
      await _api.post(
        '${_task(taskId)}/assignments/${TasksHttp.segment(assignmentId)}/reassign',
        body: {'toUserId': toUserId},
      ),
    ),
  );

  @override
  Future<TasksPage<TaskLogEntry>> history(String taskId, {String? cursor}) =>
      TasksHttp.call(() async {
        final json = await _api.get(
          '${_task(taskId)}/history',
          query: TasksHttp.query({'cursor': cursor}),
        );
        return TasksWire.page(json, TaskLogEntry.fromJson);
      });

  @override
  Future<TaskItem> republish(
    String taskId,
    TaskDraft draft, {
    required String clientRequestId,
  }) => TasksHttp.call(() async {
    // A re-published task is independent: it names no template of its own.
    final body = draft.toJson()..remove('templateId');
    return TaskItem.fromJson(
      await _api.post(
        '${_task(taskId)}/republish',
        body: {...body, 'clientRequestId': clientRequestId},
      ),
    );
  });

  @override
  Future<TasksPage<TaskTemplate>> templates({String? cursor}) => TasksHttp.call(() async {
    final json = await _api.get('/task-templates', query: TasksHttp.query({'cursor': cursor}));
    return TasksWire.page(json, TaskTemplate.fromJson);
  });

  @override
  Future<TaskTemplate> saveTemplateFromTask(String taskId) => TasksHttp.call(
    () async => TaskTemplate.fromJson(
      await _api.post('/task-templates', body: {'fromTaskId': taskId}),
    ),
  );

  @override
  Future<TaskTemplate> saveTemplateFromDraft(TaskDraft draft) => TasksHttp.call(() async {
    final body = draft.toJson()..remove('templateId');
    return TaskTemplate.fromJson(await _api.post('/task-templates', body: {'draft': body}));
  });

  @override
  Future<void> deleteTemplate(String templateId) => TasksHttp.call(
    () async => _api.delete('/task-templates/${TasksHttp.segment(templateId)}'),
  );
}
