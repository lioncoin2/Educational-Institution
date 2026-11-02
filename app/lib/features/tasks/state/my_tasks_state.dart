import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/tasks/tasks.dart';
import '../../../providers/tasks_providers.dart';
import 'paged_list_controller.dart';

/// The signed-in recipient's tasks, one list per [MyTasksScope].
class MyTasksController extends PagedListController<MyTask> {
  MyTasksController(this.scope);

  final MyTasksScope scope;

  @override
  Future<TasksPage<MyTask>> fetch(String? cursor) =>
      ref.watch(myTasksRepositoryProvider).myTasks(scope: scope, cursor: cursor);
}

final myTasksProvider = AsyncNotifierProvider.autoDispose
    .family<MyTasksController, TasksPage<MyTask>, MyTasksScope>(
      MyTasksController.new,
      retry: (_, _) => null,
    );

/// One of the recipient's tasks, by assignment.
final myTaskProvider = FutureProvider.autoDispose.family<MyTaskDetail, String>(
  (ref, assignmentId) => ref.watch(myTasksRepositoryProvider).myTask(assignmentId),
  retry: (_, _) => null,
);

/// The recipient's responses. Each re-reads the task and both lists after the
/// server accepted it; a refusal is thrown as the server's [TasksException].
class MyTaskResponses {
  MyTaskResponses(this._ref);

  final Ref _ref;

  Future<void> acknowledge(String assignmentId) => _then(
    assignmentId,
    _ref.read(myTasksRepositoryProvider).acknowledge(assignmentId),
  );

  Future<void> complete(String assignmentId, {String? report}) => _then(
    assignmentId,
    _ref.read(myTasksRepositoryProvider).complete(assignmentId, report: report),
  );

  Future<void> writeReport(String assignmentId, {required int version, required String body}) =>
      _then(
        assignmentId,
        _ref.read(myTasksRepositoryProvider).writeReport(assignmentId, version: version, body: body),
      );

  Future<void> _then(String assignmentId, Future<Object?> act) async {
    await act;
    _ref
      ..invalidate(myTaskProvider(assignmentId))
      ..invalidate(myTasksProvider);
  }
}

final myTaskResponsesProvider = Provider<MyTaskResponses>(MyTaskResponses.new);
