import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/tasks/tasks.dart';
import '../../../providers/tasks_providers.dart';

/// The dashboard's filters — also the export's, so the file matches the screen.
class DashboardFilterController extends Notifier<TaskFilter> {
  @override
  TaskFilter build() => TaskFilter.none;

  void set(TaskFilter filter) => state = filter;
}

final dashboardFilterProvider =
    NotifierProvider.autoDispose<DashboardFilterController, TaskFilter>(
      DashboardFilterController.new,
    );

final taskDashboardProvider = FutureProvider.autoDispose<TaskDashboard>(
  (ref) => ref
      .watch(taskInsightsRepositoryProvider)
      .dashboard(filter: ref.watch(dashboardFilterProvider)),
  retry: (_, _) => null,
);
