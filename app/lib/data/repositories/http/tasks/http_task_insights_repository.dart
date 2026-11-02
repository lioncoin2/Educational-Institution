import '../../../api/api_client.dart';
import '../../../models/tasks/tasks.dart';
import '../../contracts/tasks_repositories.dart';
import 'tasks_http.dart';

/// Talks to `/task-dashboard` (ADR 0052 §12): statistics and the export file.
class HttpTaskInsightsRepository implements TaskInsightsRepository {
  HttpTaskInsightsRepository(this._api);

  final ApiClient _api;

  @override
  Future<TaskDashboard> dashboard({TaskFilter filter = TaskFilter.none}) => TasksHttp.call(
    () async => TaskDashboard.fromJson(
      await _api.get('/task-dashboard', query: TasksHttp.query(filter.toQuery())),
    ),
  );

  @override
  Future<TaskExportFile> export({
    TaskFilter filter = TaskFilter.none,
    required TaskExportFormat format,
  }) => TasksHttp.call(() async {
    final download = await _api.getBytes(
      '/task-dashboard/export',
      query: {...filter.toQuery(), 'format': format.wire},
    );
    return TaskExportFile(
      format: format,
      bytes: download.bytes,
      fileName: 'tasks-report.${format.wire}',
      truncated: download.headers['x-export-truncated'] == 'true',
    );
  });
}
