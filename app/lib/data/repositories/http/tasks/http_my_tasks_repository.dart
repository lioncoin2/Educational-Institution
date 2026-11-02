import '../../../api/api_client.dart';
import '../../../models/tasks/tasks.dart';
import '../../contracts/tasks_repositories.dart';
import 'tasks_http.dart';

/// Talks to `/my-tasks` (ADR 0052 §5): the signed-in recipient's tasks.
class HttpMyTasksRepository implements MyTasksRepository {
  HttpMyTasksRepository(this._api);

  final ApiClient _api;

  String _mine(String assignmentId) => '/my-tasks/${TasksHttp.segment(assignmentId)}';

  @override
  Future<TasksPage<MyTask>> myTasks({required MyTasksScope scope, String? cursor}) =>
      TasksHttp.call(() async {
        final json = await _api.get(
          '/my-tasks',
          query: TasksHttp.query({'scope': scope.wire, 'cursor': cursor}),
        );
        return TasksWire.page(json, MyTask.fromJson);
      });

  @override
  Future<MyTaskDetail> myTask(String assignmentId) =>
      TasksHttp.call(() async => MyTaskDetail.fromJson(await _api.get(_mine(assignmentId))));

  @override
  Future<MyTaskDetail> myTaskByTask(String taskId) => TasksHttp.call(
    () async =>
        MyTaskDetail.fromJson(await _api.get('/my-tasks/by-task/${TasksHttp.segment(taskId)}')),
  );

  @override
  Future<TaskAssignment> acknowledge(String assignmentId) => TasksHttp.call(
    () async =>
        TaskAssignment.fromJson(await _api.post('${_mine(assignmentId)}/acknowledge')),
  );

  @override
  Future<TaskAssignment> complete(String assignmentId, {String? report}) => TasksHttp.call(
    () async => TaskAssignment.fromJson(
      await _api.post(
        '${_mine(assignmentId)}/complete',
        body: report == null ? null : {'report': report},
      ),
    ),
  );

  @override
  Future<TaskReport> writeReport(
    String assignmentId, {
    required int version,
    required String body,
  }) => TasksHttp.call(
    () async => TaskReport.fromJson(
      await _api.put('${_mine(assignmentId)}/report', body: {'version': version, 'body': body}),
    ),
  );
}
