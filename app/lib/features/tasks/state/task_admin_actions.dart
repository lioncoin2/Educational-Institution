import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/client_ids.dart';
import '../../../data/models/tasks/tasks.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/tasks_providers.dart';
import 'task_admin_state.dart';
import 'task_templates_state.dart';

/// The administration's acts on tasks. Each re-reads what it changed once the
/// server accepted it; a refusal is thrown as the server's [TasksException].
class TaskAdminActions {
  TaskAdminActions(this._ref);

  final Ref _ref;

  /// [clientRequestId] is minted once per composer, so a retried tap lands once.
  Future<TaskItem> publish(TaskDraft draft, {required String clientRequestId}) async {
    final task = await _repo.publish(draft, clientRequestId: clientRequestId);
    _ref.invalidate(taskListProvider);
    return task;
  }

  Future<TaskItem> edit(String taskId, TaskEdit edit) => _touching(taskId, _repo.edit(taskId, edit));

  Future<TaskItem> cancel(String taskId) => _touching(taskId, _repo.cancel(taskId));

  Future<TaskItem> reopen(String taskId) => _touching(taskId, _repo.reopen(taskId));

  Future<int> remind(String taskId) async {
    final reminded = await _repo.remindNonResponders(taskId);
    _ref.invalidate(taskHistoryProvider(taskId));
    return reminded;
  }

  Future<void> reassign(String taskId, String assignmentId, {required String toUserId}) =>
      _touching(taskId, _repo.reassign(taskId, assignmentId, toUserId: toUserId));

  Future<TaskItem> republish(
    String taskId,
    TaskDraft draft, {
    required String clientRequestId,
  }) async {
    final task = await _repo.republish(taskId, draft, clientRequestId: clientRequestId);
    _ref.invalidate(taskListProvider);
    return task;
  }

  Future<void> saveTemplateFromTask(String taskId) async {
    await _repo.saveTemplateFromTask(taskId);
    _ref.invalidate(taskTemplatesProvider);
  }

  Future<void> saveTemplateFromDraft(TaskDraft draft) async {
    await _repo.saveTemplateFromDraft(draft);
    _ref.invalidate(taskTemplatesProvider);
  }

  Future<void> deleteTemplate(String templateId) async {
    await _repo.deleteTemplate(templateId);
    _ref.invalidate(taskTemplatesProvider);
  }

  /// A fresh idempotency key for one composer.
  static String newRequestId() => newClientId();

  TaskAdministrationRepository get _repo => _ref.read(taskAdministrationRepositoryProvider);

  Future<T> _touching<T>(String taskId, Future<T> act) async {
    final result = await act;
    _ref
      ..invalidate(taskDetailProvider(taskId))
      ..invalidate(trackingProvider)
      ..invalidate(taskHistoryProvider(taskId))
      ..invalidate(taskListProvider);
    return result;
  }
}

final taskAdminActionsProvider = Provider<TaskAdminActions>(TaskAdminActions.new);
