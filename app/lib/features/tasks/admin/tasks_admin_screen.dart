import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/task_admin_state.dart';
import '../state/tasks_permissions.dart';
import '../widgets/task_filter_bar.dart';
import '../widgets/task_format.dart';
import '../widgets/task_pill.dart';
import '../widgets/tasks_paged_list.dart';

/// «المهام اليومية» — the administration's tasks (`tasks.manage`): search and
/// filters over every task, how each is being answered, and the way to the
/// composer, the reports, the statistics and (for the owner) the templates.
class TasksAdminScreen extends ConsumerWidget {
  const TasksAdminScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final templates = ref.watch(canUseTaskTemplatesProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(TasksCopy.adminTitle),
        actions: [
          IconButton(
            key: const Key('tasks-open-reports'),
            tooltip: TasksCopy.reportsTitle,
            onPressed: () => context.push(Routes.taskReports),
            icon: const Icon(Icons.fact_check_outlined),
          ),
          IconButton(
            key: const Key('tasks-open-dashboard'),
            tooltip: TasksCopy.dashboardTitle,
            onPressed: () => context.push(Routes.taskDashboard),
            icon: const Icon(Icons.insights_outlined),
          ),
          if (templates)
            IconButton(
              key: const Key('tasks-open-templates'),
              tooltip: TasksCopy.templatesTitle,
              onPressed: () => context.push(Routes.taskTemplates),
              icon: const Icon(Icons.copy_all_outlined),
            ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('tasks-new'),
        onPressed: () => context.push(Routes.taskCompose),
        icon: const Icon(Icons.add_task),
        label: const Text(TasksCopy.newTask),
      ),
      body: SafeArea(
        top: false,
        child: TasksPagedList<TaskOverview>(
          value: ref.watch(taskListProvider),
          onRefresh: () => ref.read(taskListProvider.notifier).refresh(),
          onLoadMore: () => ref.read(taskListProvider.notifier).loadMore(),
          onRetry: () => ref.invalidate(taskListProvider),
          emptyIcon: Icons.assignment_outlined,
          emptyTitle: TasksCopy.adminEmpty,
          emptyMessage: TasksCopy.adminEmptyMessage,
          header: TaskFilterBar(
            filter: ref.watch(taskListFilterProvider),
            onChanged: ref.read(taskListFilterProvider.notifier).set,
          ),
          itemBuilder: (context, item) => TaskOverviewCard(item: item),
        ),
      ),
    );
  }
}

/// A task in the list: its title, audiences, state and response counts.
class TaskOverviewCard extends StatelessWidget {
  const TaskOverviewCard({super.key, required this.item});

  final TaskOverview item;

  @override
  Widget build(BuildContext context) {
    final task = item.task;
    final counts = item.counts;
    return AppCard(
      key: Key('task-${task.id}'),
      onTap: () => context.push(Routes.task(task.id)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(task.title, style: context.text.titleSmall)),
              TaskPill.state(task.state),
            ],
          ),
          const SizedBox(height: Insets.xs),
          Text(
            '${task.audiences.map(TasksLabels.audience).join('، ')} · '
            '${TasksLabels.kind(task.kind)} · ${TaskFormat.when(task.createdAt)}',
            style: context.text.bodySmall,
          ),
          const SizedBox(height: Insets.xs),
          Text(
            TasksCopy.countsLine(counts.responded, counts.completed, counts.targets),
            style: context.text.bodyMedium,
          ),
          if (counts.reportsPending > 0)
            Padding(
              padding: const EdgeInsets.only(top: Insets.xs),
              child: TaskPill(
                label: '${TasksLabels.report(ReportStatus.pendingReview)}: ${counts.reportsPending}',
                tone: PillTone.attention,
              ),
            ),
        ],
      ),
    );
  }
}
