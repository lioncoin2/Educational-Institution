import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/task_admin_state.dart';
import '../widgets/task_format.dart';
import '../widgets/tasks_paged_list.dart';

/// A task's operation log (roadmap §7): every act, who did it and when.
class TaskHistoryTab extends ConsumerWidget {
  const TaskHistoryTab({super.key, required this.taskId});

  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = taskHistoryProvider(taskId);
    return TasksPagedList<TaskLogEntry>(
      value: ref.watch(provider),
      onRefresh: () => ref.read(provider.notifier).refresh(),
      onLoadMore: () => ref.read(provider.notifier).loadMore(),
      onRetry: () => ref.invalidate(provider),
      emptyIcon: Icons.history,
      emptyTitle: TasksCopy.historyEmpty,
      itemBuilder: (context, entry) => ListTile(
        key: Key('history-${entry.sequence}'),
        dense: true,
        leading: const Icon(Icons.circle, size: 10),
        title: Text(TasksLabels.action(entry.action), style: context.text.bodyMedium),
        subtitle: Text('${TaskFormat.person(entry.actor)} · ${TaskFormat.when(entry.occurredAt)}'),
      ),
    );
  }
}
