import '../../../api/api_client.dart';
import '../../../models/tasks/tasks.dart';
import '../../contracts/tasks_repositories.dart';
import 'tasks_http.dart';

/// Talks to `/task-reports` (ADR 0052 §6): the reports page and its review.
class HttpTaskReportsRepository implements TaskReportsRepository {
  HttpTaskReportsRepository(this._api);

  final ApiClient _api;

  String _report(String reportId) => '/task-reports/${TasksHttp.segment(reportId)}';

  @override
  Future<TasksPage<ReportSummary>> reports({
    TaskFilter filter = TaskFilter.none,
    ReportCategory? category,
    String? cursor,
  }) => TasksHttp.call(() async {
    final json = await _api.get(
      '/task-reports',
      query: TasksHttp.query({
        ...filter.toQuery(),
        'category': category?.wire,
        'cursor': cursor,
      }),
    );
    return TasksWire.page(json, ReportSummary.fromJson);
  });

  @override
  Future<ReportDetail> report(String reportId) =>
      TasksHttp.call(() async => ReportDetail.fromJson(await _api.get(_report(reportId))));

  @override
  Future<TaskReport> review(
    String reportId, {
    required int version,
    required ReviewDecision decision,
    String? note,
  }) => TasksHttp.call(
    () async => TaskReport.fromJson(
      await _api.post(
        '${_report(reportId)}/review',
        body: {'version': version, 'decision': decision.wire, 'note': ?note},
      ),
    ),
  );

  @override
  Future<TaskReport> edit(String reportId, {required int version, required String body}) =>
      TasksHttp.call(
        () async => TaskReport.fromJson(
          await _api.put(_report(reportId), body: {'version': version, 'body': body}),
        ),
      );

  @override
  Future<TaskReport> delete(String reportId) =>
      TasksHttp.call(() async => TaskReport.fromJson(await _api.delete(_report(reportId))));
}
