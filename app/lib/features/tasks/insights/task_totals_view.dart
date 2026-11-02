import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../widgets/task_format.dart';

/// One set of totals: the two rates, then the counts behind them.
class TaskTotalsView extends StatelessWidget {
  const TaskTotalsView({super.key, required this.totals, this.title, this.showTasks = true});

  final TaskTotals totals;
  final String? title;
  final bool showTasks;

  @override
  Widget build(BuildContext context) {
    final figures = [
      if (showTasks) (TasksCopy.tasksCount, '${totals.tasks}'),
      if (showTasks) (TasksCopy.archivedCount, '${totals.tasksArchived}'),
      (TasksCopy.assignmentsCount, '${totals.assignments}'),
      (TasksCopy.ackRate, TaskFormat.rate(totals.acknowledgementRate)),
      (TasksCopy.completionRate, TaskFormat.rate(totals.completionRate)),
      (TasksCopy.completedCount, '${totals.completed}'),
      (TasksCopy.notCompletedCount, '${totals.notCompleted}'),
      (TasksCopy.approvedCount, '${totals.reportsApproved}'),
      (TasksCopy.changesCount, '${totals.reportsChangesRequested}'),
      (TasksCopy.pendingCount, '${totals.reportsPending}'),
    ];
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null) ...[
            Text(title!, style: context.text.titleSmall),
            const SizedBox(height: Insets.sm),
          ],
          Wrap(
            spacing: Insets.lg,
            runSpacing: Insets.sm,
            children: [
              for (final (label, value) in figures)
                SizedBox(
                  width: 120,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(value, style: context.text.titleMedium),
                      Text(label, style: context.text.bodySmall),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
