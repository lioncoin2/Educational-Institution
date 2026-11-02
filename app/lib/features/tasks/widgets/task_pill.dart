import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_labels.dart';

/// The tone a state is shown in.
enum PillTone { neutral, positive, attention, negative }

/// A small coloured label for a state (a task's, an assignment's, a report's).
class TaskPill extends StatelessWidget {
  const TaskPill({super.key, required this.label, this.tone = PillTone.neutral});

  TaskPill.state(TaskState state, {super.key})
    : label = TasksLabels.state(state),
      tone = switch (state) {
        TaskState.active => PillTone.positive,
        TaskState.cancelled => PillTone.negative,
        _ => PillTone.neutral,
      };

  TaskPill.assignment(AssignmentStatus status, {super.key})
    : label = TasksLabels.assignment(status),
      tone = switch (status) {
        AssignmentStatus.completed => PillTone.positive,
        AssignmentStatus.acknowledged => PillTone.attention,
        AssignmentStatus.pending => PillTone.negative,
        _ => PillTone.neutral,
      };

  TaskPill.report(ReportStatus status, {super.key})
    : label = TasksLabels.report(status),
      tone = switch (status) {
        ReportStatus.approved => PillTone.positive,
        ReportStatus.pendingReview => PillTone.attention,
        ReportStatus.changesRequested => PillTone.negative,
        _ => PillTone.neutral,
      };

  final String label;
  final PillTone tone;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final color = switch (tone) {
      PillTone.positive => colors.primary,
      PillTone.attention => colors.tertiary,
      PillTone.negative => colors.error,
      PillTone.neutral => colors.outline,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Insets.sm, vertical: 2),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: Radii.pill),
      child: Text(label, style: context.text.labelSmall?.copyWith(color: color)),
    );
  }
}
