import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../widgets/task_format.dart';
import '../widgets/task_pill.dart';

/// A task's head on its follow-up page: what it asks, of whom, how it is
/// answered, who published it, and how far the answers have got.
class TaskSummaryCard extends StatelessWidget {
  const TaskSummaryCard({super.key, required this.detail, this.actions});

  final TaskDetail detail;
  final Widget? actions;

  @override
  Widget build(BuildContext context) {
    final task = detail.task;
    final counts = detail.counts;
    final settings = [
      task.audiences.map(TasksLabels.audience).join('، '),
      TasksLabels.kind(task.kind),
      task.buttons.map(TasksLabels.button).join(' / '),
      if (task.reportRequired) '${TasksCopy.reportRequired} · ${TasksLabels.approval(task.approvalMode)}',
    ];
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(task.title, style: context.text.titleMedium)),
              TaskPill.state(task.state),
            ],
          ),
          if (task.body.trim().isNotEmpty) ...[
            const SizedBox(height: Insets.sm),
            SelectableText(task.body, style: context.text.bodyMedium),
          ],
          const SizedBox(height: Insets.sm),
          Text(settings.where((s) => s.isNotEmpty).join(' · '), style: context.text.bodySmall),
          Text(
            '${TasksCopy.publishedBy}: ${TaskFormat.person(detail.createdBy)} · '
            '${TaskFormat.when(task.createdAt)} · ${TasksCopy.revisionLine(task.revision)}',
            style: context.text.bodySmall,
          ),
          if (detail.cancelledBy != null && task.cancelledAt != null)
            Text(
              '${TasksCopy.cancelledBy}: ${TaskFormat.person(detail.cancelledBy)} · '
              '${TaskFormat.when(task.cancelledAt!)}',
              style: context.text.bodySmall,
            ),
          const SizedBox(height: Insets.md),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.xs,
            children: [
              TaskPill(
                label: TasksCopy.countsLine(counts.responded, counts.completed, counts.targets),
                tone: PillTone.positive,
              ),
              if (counts.reportsPending > 0)
                TaskPill(
                  label: '${TasksCopy.pendingCount}: ${counts.reportsPending}',
                  tone: PillTone.attention,
                ),
              if (counts.reportsChangesRequested > 0)
                TaskPill(
                  label: '${TasksCopy.changesCount}: ${counts.reportsChangesRequested}',
                  tone: PillTone.negative,
                ),
              if (counts.reportsApproved > 0)
                TaskPill(label: '${TasksCopy.approvedCount}: ${counts.reportsApproved}'),
            ],
          ),
          if (actions != null) ...[const SizedBox(height: Insets.md), actions!],
        ],
      ),
    );
  }
}
