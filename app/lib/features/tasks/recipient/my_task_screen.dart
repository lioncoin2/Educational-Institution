import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../core/widgets/foundations/empty_state.dart';
import '../../../core/widgets/foundations/section_header.dart';
import '../../../core/widgets/layout/responsive_body.dart';
import '../../../data/models/tasks/tasks.dart';
import '../../auth/sign_in_prompt.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/my_tasks_state.dart';
import '../widgets/review_notes.dart';
import '../widgets/task_format.dart';
import '../widgets/task_pill.dart';
import 'my_task_response_panel.dart';

/// One of the recipient's tasks: its instructions, where they stand, their
/// response controls, and their report with the reviewers' notes.
class MyTaskScreen extends ConsumerWidget {
  const MyTaskScreen({super.key, required this.assignmentId});

  final String assignmentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = myTaskProvider(assignmentId);
    void retry() => ref.invalidate(provider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(TasksCopy.myTasksTitle),
        actions: [
          IconButton(
            tooltip: TasksCopy.refresh,
            onPressed: retry,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView<MyTaskDetail>(
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
          builder: (context, detail) => RefreshIndicator(
            onRefresh: () => ref.refresh(provider.future),
            child: ListView(
              padding: const EdgeInsets.symmetric(vertical: Insets.lg),
              children: [
                ResponsiveBody(child: _TaskCard(detail: detail)),
                const SizedBox(height: Insets.lg),
                ResponsiveBody(child: MyTaskResponsePanel(detail: detail)),
                if (detail.reviews.isNotEmpty) ...[
                  const SizedBox(height: Insets.lg),
                  const ResponsiveBody(child: SectionHeader(title: TasksCopy.reviewerNotes)),
                  ResponsiveBody(child: AppCard(child: ReviewNotes(reviews: detail.reviews))),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.detail});

  final MyTaskDetail detail;

  @override
  Widget build(BuildContext context) {
    final task = detail.task;
    final assignment = detail.assignment;
    final times = [
      '${TasksCopy.receivedAt}: ${TaskFormat.when(assignment.createdAt)}',
      if (TaskFormat.maybeWhen(assignment.acknowledgedAt) case final at?)
        '${TasksCopy.acknowledgedAt}: $at',
      if (TaskFormat.maybeWhen(assignment.completedAt) case final at?)
        '${TasksCopy.completedAt}: $at',
    ];
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(task.title, style: context.text.titleMedium),
          const SizedBox(height: Insets.sm),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.xs,
            children: [
              TaskPill(label: TasksLabels.kind(task.kind)),
              TaskPill.assignment(assignment.status),
              if (!task.isActive) TaskPill.state(task.state),
            ],
          ),
          if (task.body.trim().isNotEmpty) ...[
            const SizedBox(height: Insets.md),
            Text(TasksCopy.instructions, style: context.text.labelLarge),
            const SizedBox(height: Insets.xs),
            SelectableText(task.body, style: context.text.bodyMedium),
          ],
          const SizedBox(height: Insets.md),
          for (final line in times) Text(line, style: context.text.bodySmall),
        ],
      ),
    );
  }
}
