import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/tasks/tasks.dart';
import '../../../providers/tasks_providers.dart';
import 'paged_list_controller.dart';

/// The owner's saved task configurations, newest first.
class TaskTemplatesController extends PagedListController<TaskTemplate> {
  @override
  Future<TasksPage<TaskTemplate>> fetch(String? cursor) =>
      ref.watch(taskAdministrationRepositoryProvider).templates(cursor: cursor);
}

final taskTemplatesProvider =
    AsyncNotifierProvider.autoDispose<TaskTemplatesController, TasksPage<TaskTemplate>>(
      TaskTemplatesController.new,
      retry: (_, _) => null,
    );
