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
import '../state/my_tasks_state.dart';
import '../widgets/task_format.dart';
import '../widgets/task_pill.dart';
import '../widgets/tasks_paged_list.dart';

/// «مهامي» — the tasks that reached the signed-in staff member (`tasks.respond`),
/// still to do and done. The server answers by the authenticated identity.
class MyTasksScreen extends StatelessWidget {
  const MyTasksScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text(TasksCopy.myTasksTitle),
          bottom: const TabBar(
            tabs: [Tab(text: TasksCopy.openTab), Tab(text: TasksCopy.doneTab)],
          ),
        ),
        body: const SafeArea(
          top: false,
          child: TabBarView(
            children: [_MyList(MyTasksScope.open), _MyList(MyTasksScope.done)],
          ),
        ),
      ),
    );
  }
}

class _MyList extends ConsumerWidget {
  const _MyList(this.scope);

  final MyTasksScope scope;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = myTasksProvider(scope);
    return TasksPagedList<MyTask>(
      key: Key('my-tasks-${scope.wire}'),
      value: ref.watch(provider),
      onRefresh: () => ref.read(provider.notifier).refresh(),
      onLoadMore: () => ref.read(provider.notifier).loadMore(),
      onRetry: () => ref.invalidate(provider),
      emptyIcon: Icons.task_alt_outlined,
      emptyTitle: TasksCopy.myEmpty,
      emptyMessage: TasksCopy.myEmptyMessage,
      itemBuilder: (context, item) => _MyTaskCard(item: item),
    );
  }
}

class _MyTaskCard extends StatelessWidget {
  const _MyTaskCard({required this.item});

  final MyTask item;

  @override
  Widget build(BuildContext context) {
    final report = item.report;
    return AppCard(
      key: Key('my-task-${item.assignment.id}'),
      onTap: () => context.push(Routes.myTask(item.assignment.id)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(item.task.title, style: context.text.titleSmall),
          const SizedBox(height: Insets.xs),
          Text(
            '${TasksLabels.kind(item.task.kind)} · ${TasksCopy.receivedAt} '
            '${TaskFormat.when(item.assignment.createdAt)}',
            style: context.text.bodySmall,
          ),
          const SizedBox(height: Insets.sm),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.xs,
            children: [
              TaskPill.assignment(item.assignment.status),
              if (report != null) TaskPill.report(report.status),
              if (!item.task.isActive) TaskPill.state(item.task.state),
            ],
          ),
        ],
      ),
    );
  }
}
