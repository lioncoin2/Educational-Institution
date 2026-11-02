import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../data/models/tasks/tasks.dart';
import '../../academic_admin/widgets/person_picker_sheet.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/task_admin_actions.dart';
import '../state/task_admin_state.dart';
import '../widgets/task_feedback.dart';
import '../widgets/task_format.dart';
import '../widgets/task_pill.dart';
import '../widgets/tasks_paged_list.dart';

/// The follow-up page proper (roadmap §4): every recipient, whether and when
/// they received and completed the task, their report's state — filtered by
/// response — with a reassignment for those who have not finished.
class TaskTrackingTab extends ConsumerStatefulWidget {
  const TaskTrackingTab({super.key, required this.detail, required this.header});

  final TaskDetail detail;
  final Widget header;

  @override
  ConsumerState<TaskTrackingTab> createState() => _TaskTrackingTabState();
}

class _TaskTrackingTabState extends ConsumerState<TaskTrackingTab> {
  TrackingFilter _filter = TrackingFilter.all;

  @override
  Widget build(BuildContext context) {
    final provider = trackingProvider((taskId: widget.detail.task.id, filter: _filter));
    return TasksPagedList<TrackingRow>(
      value: ref.watch(provider),
      onRefresh: () => ref.read(provider.notifier).refresh(),
      onLoadMore: () => ref.read(provider.notifier).loadMore(),
      onRetry: () => ref.invalidate(provider),
      emptyIcon: Icons.people_outline,
      emptyTitle: TasksCopy.trackingEmpty,
      header: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          widget.header,
          const SizedBox(height: Insets.md),
          Wrap(
            spacing: Insets.sm,
            children: [
              for (final filter in TrackingFilter.values)
                ChoiceChip(
                  key: Key('tracking-filter-${filter.wire}'),
                  label: Text(TasksLabels.tracking(filter)),
                  selected: _filter == filter,
                  onSelected: (_) => setState(() => _filter = filter),
                ),
            ],
          ),
          const SizedBox(height: Insets.md),
        ],
      ),
      itemBuilder: (context, row) => _TrackingRowCard(task: widget.detail.task, row: row),
    );
  }
}

class _TrackingRowCard extends ConsumerWidget {
  const _TrackingRowCard({required this.task, required this.row});

  final TaskItem task;
  final TrackingRow row;

  Future<void> _reassign(BuildContext context, WidgetRef ref) async {
    final person = await showPersonPicker(context, title: TasksCopy.reassignTo);
    if (person == null || !context.mounted) return;
    await runTaskAct(
      context,
      () => ref
          .read(taskAdminActionsProvider)
          .reassign(task.id, row.assignment.id, toUserId: person.userId),
      success: TasksCopy.reassigned,
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final assignment = row.assignment;
    final report = row.report;
    final times = [
      if (TaskFormat.maybeWhen(assignment.acknowledgedAt) case final at?)
        '${TasksCopy.acknowledgedAt}: $at',
      if (TaskFormat.maybeWhen(assignment.completedAt) case final at?)
        '${TasksCopy.completedAt}: $at',
      if (assignment.isReassigned && assignment.reassignedAt != null)
        '${TasksLabels.assignment(AssignmentStatus.reassigned)}: '
            '${TaskFormat.when(assignment.reassignedAt!)} · ${TaskFormat.person(row.reassignedBy)}',
      if (assignment.replaces != null) TasksCopy.replacedSomeone,
    ];
    final canReassign =
        task.isActive && (assignment.isPending || assignment.isAcknowledged);
    return AppCard(
      key: Key('tracking-${assignment.id}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(TaskFormat.person(row.recipient), style: context.text.titleSmall),
              ),
              TaskPill.assignment(assignment.status),
            ],
          ),
          Text(TasksLabels.audience(assignment.audience), style: context.text.bodySmall),
          for (final line in times) Text(line, style: context.text.bodySmall),
          if (report != null || canReassign)
            Row(
              children: [
                if (report != null)
                  TextButton.icon(
                    key: Key('tracking-report-${report.id}'),
                    onPressed: () => context.push(Routes.taskReport(report.id)),
                    icon: const Icon(Icons.description_outlined),
                    label: Text(
                      '${TasksCopy.reportOf}: ${TasksLabels.report(report.status)}',
                    ),
                  ),
                const Spacer(),
                if (canReassign)
                  TextButton.icon(
                    key: Key('tracking-reassign-${assignment.id}'),
                    onPressed: () => _reassign(context, ref),
                    icon: const Icon(Icons.swap_horiz),
                    label: const Text(TasksCopy.reassign),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}
