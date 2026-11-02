import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/tasks/tasks.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/tasks_providers.dart';
import 'paged_list_controller.dart';

/// The reports page's category and filters.
typedef ReportsQuery = ({ReportCategory category, TaskFilter filter});

class ReportsQueryController extends Notifier<ReportsQuery> {
  @override
  ReportsQuery build() => (category: ReportCategory.taskCompletion, filter: TaskFilter.none);

  void set(ReportsQuery query) => state = query;
}

final reportsQueryProvider = NotifierProvider.autoDispose<ReportsQueryController, ReportsQuery>(
  ReportsQueryController.new,
);

/// The reports of the chosen category, most recently changed first.
class ReportsController extends PagedListController<ReportSummary> {
  @override
  Future<TasksPage<ReportSummary>> fetch(String? cursor) {
    final query = ref.watch(reportsQueryProvider);
    return ref
        .watch(taskReportsRepositoryProvider)
        .reports(filter: query.filter, category: query.category, cursor: cursor);
  }
}

final reportsProvider =
    AsyncNotifierProvider.autoDispose<ReportsController, TasksPage<ReportSummary>>(
      ReportsController.new,
      retry: (_, _) => null,
    );

/// One report's page, with every version and review.
final reportDetailProvider = FutureProvider.autoDispose.family<ReportDetail, String>(
  (ref, reportId) => ref.watch(taskReportsRepositoryProvider).report(reportId),
  retry: (_, _) => null,
);

/// A reviewer's acts on a report; each re-reads the report and the list.
class ReportActions {
  ReportActions(this._ref);

  final Ref _ref;

  Future<void> review(
    String reportId, {
    required int version,
    required ReviewDecision decision,
    String? note,
  }) => _then(
    reportId,
    _repo.review(reportId, version: version, decision: decision, note: note),
  );

  Future<void> edit(String reportId, {required int version, required String body}) =>
      _then(reportId, _repo.edit(reportId, version: version, body: body));

  Future<void> delete(String reportId) => _then(reportId, _repo.delete(reportId));

  TaskReportsRepository get _repo => _ref.read(taskReportsRepositoryProvider);

  Future<void> _then(String reportId, Future<Object?> act) async {
    await act;
    _ref
      ..invalidate(reportDetailProvider(reportId))
      ..invalidate(reportsProvider);
  }
}

final reportActionsProvider = Provider<ReportActions>(ReportActions.new);
