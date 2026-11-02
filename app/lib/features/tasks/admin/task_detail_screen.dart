import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../core/widgets/foundations/empty_state.dart';
import '../../../core/widgets/layout/responsive_body.dart';
import '../../../data/models/tasks/tasks.dart';
import '../../auth/sign_in_prompt.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/task_admin_state.dart';
import '../widgets/task_format.dart';
import 'task_actions_bar.dart';
import 'task_history_tab.dart';
import 'task_summary_card.dart';
import 'task_tracking_tab.dart';

/// One task as the administration follows it: its head and actions, then the
/// recipients, the operation log and the edit history in tabs.
class TaskDetailScreen extends ConsumerWidget {
  const TaskDetailScreen({super.key, required this.taskId});

  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = taskDetailProvider(taskId);
    void retry() => ref.invalidate(provider);
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text(TasksCopy.adminTitle),
          actions: [
            IconButton(
              tooltip: TasksCopy.refresh,
              onPressed: retry,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
          bottom: const TabBar(
            tabs: [
              Tab(text: TasksCopy.trackingTab),
              Tab(text: TasksCopy.historyTab),
              Tab(text: TasksCopy.revisionsTab),
            ],
          ),
        ),
        body: SafeArea(
          top: false,
          child: AsyncView<TaskDetail>(
            value: ref.watch(provider),
            onRetry: retry,
            errorBuilder: (context, error) =>
                SignInPrompt.forError(error, onReturn: retry) ??
                EmptyState(
                  icon: Icons.error_outline,
                  title: TasksLabels.error(error),
                  actionLabel: TasksCopy.refresh,
                  onAction: retry,
                ),
            builder: (context, detail) => TabBarView(
              children: [
                TaskTrackingTab(
                  detail: detail,
                  header: TaskSummaryCard(
                    detail: detail,
                    actions: TaskActionsBar(detail: detail),
                  ),
                ),
                TaskHistoryTab(taskId: taskId),
                _Revisions(revisions: detail.revisions),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Every saved state of the task, newest first.
class _Revisions extends StatelessWidget {
  const _Revisions({required this.revisions});

  final List<TaskRevision> revisions;

  @override
  Widget build(BuildContext context) {
    final newestFirst = revisions.reversed.toList(growable: false);
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: Insets.md),
      itemCount: newestFirst.length,
      itemBuilder: (context, index) {
        final revision = newestFirst[index];
        return ResponsiveBody(
          child: ListTile(
            key: Key('revision-${revision.revision}'),
            title: Text(revision.title, style: context.text.titleSmall),
            subtitle: Text(
              '${TasksCopy.revisionLine(revision.revision)} · '
              '${TaskFormat.person(revision.editedBy)} · ${TaskFormat.when(revision.editedAt)}'
              '${revision.requireReacknowledge ? ' · ${TasksCopy.requireReacknowledge}' : ''}',
            ),
          ),
        );
      },
    );
  }
}
