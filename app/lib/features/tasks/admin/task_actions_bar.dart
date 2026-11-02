import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../state/task_admin_actions.dart';
import '../state/tasks_permissions.dart';
import '../widgets/task_feedback.dart';

/// What the administration can do with one task (ADR 0052 §7–§8): edit it,
/// remind those who have not responded, cancel or reopen it, and — the owner —
/// re-publish it or keep it as a template.
class TaskActionsBar extends ConsumerStatefulWidget {
  const TaskActionsBar({super.key, required this.detail});

  final TaskDetail detail;

  @override
  ConsumerState<TaskActionsBar> createState() => _TaskActionsBarState();
}

class _TaskActionsBarState extends ConsumerState<TaskActionsBar> {
  bool _busy = false;

  TaskItem get _task => widget.detail.task;

  Future<void> _run<T>(
    Future<T> Function() act, {
    String? success,
    String Function(T)? describe,
  }) async {
    setState(() => _busy = true);
    await runTaskAct<T>(context, act, success: success, describe: describe);
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _cancel() async {
    final sure = await confirmTaskAct(
      context,
      title: TasksCopy.cancelTask,
      question: TasksCopy.cancelQuestion,
    );
    if (!sure || !mounted) return;
    await _run(() => ref.read(taskAdminActionsProvider).cancel(_task.id), success: TasksCopy.cancelled);
  }

  Future<void> _reopen() async {
    final sure = await confirmTaskAct(
      context,
      title: TasksCopy.reopenTask,
      question: TasksCopy.reopenQuestion,
    );
    if (!sure || !mounted) return;
    await _run(() => ref.read(taskAdminActionsProvider).reopen(_task.id), success: TasksCopy.reopened);
  }

  @override
  Widget build(BuildContext context) {
    final owner = ref.watch(canUseTaskTemplatesProvider);
    final actions = ref.read(taskAdminActionsProvider);
    final active = _task.isActive;
    return Wrap(
      spacing: Insets.sm,
      runSpacing: Insets.sm,
      children: [
        if (active) ...[
          OutlinedButton.icon(
            key: const Key('task-edit'),
            onPressed: _busy ? null : () => context.push(Routes.taskEdit(_task.id)),
            icon: const Icon(Icons.edit_outlined),
            label: const Text(TasksCopy.edit),
          ),
          FilledButton.tonalIcon(
            key: const Key('task-remind'),
            onPressed: _busy || widget.detail.counts.notResponded == 0
                ? null
                : () => _run<int>(() => actions.remind(_task.id), describe: TasksCopy.reminded),
            icon: const Icon(Icons.notifications_active_outlined),
            label: const Text(TasksCopy.remind),
          ),
          OutlinedButton.icon(
            key: const Key('task-cancel'),
            onPressed: _busy ? null : _cancel,
            icon: const Icon(Icons.block_outlined),
            label: const Text(TasksCopy.cancelTask),
          ),
        ] else
          OutlinedButton.icon(
            key: const Key('task-reopen'),
            onPressed: _busy ? null : _reopen,
            icon: const Icon(Icons.restore_outlined),
            label: const Text(TasksCopy.reopenTask),
          ),
        if (owner) ...[
          OutlinedButton.icon(
            key: const Key('task-republish'),
            onPressed: _busy ? null : () => context.push(Routes.taskRepublish(_task.id)),
            icon: const Icon(Icons.replay_outlined),
            label: const Text(TasksCopy.republish),
          ),
          OutlinedButton.icon(
            key: const Key('task-save-template'),
            onPressed: _busy
                ? null
                : () => _run(
                    () => actions.saveTemplateFromTask(_task.id),
                    success: TasksCopy.templateSaved,
                  ),
            icon: const Icon(Icons.bookmark_add_outlined),
            label: const Text(TasksCopy.saveAsTemplate),
          ),
        ],
      ],
    );
  }
}
