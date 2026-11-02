import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/tasks/tasks.dart';
import '../../../providers/tasks_providers.dart';
import 'paged_list_controller.dart';

/// The administration list's search and filters.
class TaskFilterController extends Notifier<TaskFilter> {
  @override
  TaskFilter build() => TaskFilter.none;

  void set(TaskFilter filter) => state = filter;
}

final taskListFilterProvider = NotifierProvider.autoDispose<TaskFilterController, TaskFilter>(
  TaskFilterController.new,
);

/// The administration's tasks, newest first, under the current filter.
class TaskListController extends PagedListController<TaskOverview> {
  @override
  Future<TasksPage<TaskOverview>> fetch(String? cursor) => ref
      .watch(taskAdministrationRepositoryProvider)
      .tasks(filter: ref.watch(taskListFilterProvider), cursor: cursor);
}

final taskListProvider =
    AsyncNotifierProvider.autoDispose<TaskListController, TasksPage<TaskOverview>>(
      TaskListController.new,
      retry: (_, _) => null,
    );

/// One task's page.
final taskDetailProvider = FutureProvider.autoDispose.family<TaskDetail, String>(
  (ref, taskId) => ref.watch(taskAdministrationRepositoryProvider).task(taskId),
  retry: (_, _) => null,
);

/// A task's recipients on the follow-up page, under one filter.
typedef TrackingKey = ({String taskId, TrackingFilter filter});

class TrackingController extends PagedListController<TrackingRow> {
  TrackingController(this.key);

  final TrackingKey key;

  @override
  Future<TasksPage<TrackingRow>> fetch(String? cursor) => ref
      .watch(taskAdministrationRepositoryProvider)
      .tracking(key.taskId, filter: key.filter, cursor: cursor);
}

final trackingProvider = AsyncNotifierProvider.autoDispose
    .family<TrackingController, TasksPage<TrackingRow>, TrackingKey>(
      TrackingController.new,
      retry: (_, _) => null,
    );

/// A task's operation log, oldest first.
class TaskHistoryController extends PagedListController<TaskLogEntry> {
  TaskHistoryController(this.taskId);

  final String taskId;

  @override
  Future<TasksPage<TaskLogEntry>> fetch(String? cursor) =>
      ref.watch(taskAdministrationRepositoryProvider).history(taskId, cursor: cursor);
}

final taskHistoryProvider = AsyncNotifierProvider.autoDispose
    .family<TaskHistoryController, TasksPage<TaskLogEntry>, String>(
      TaskHistoryController.new,
      retry: (_, _) => null,
    );
