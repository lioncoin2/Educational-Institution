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
import '../state/task_reports_state.dart';
import '../widgets/task_filter_bar.dart';
import '../widgets/task_format.dart';
import '../widgets/task_pill.dart';
import '../widgets/tasks_paged_list.dart';

/// «التقارير» — the reports, by the category the server filed them under
/// (never chosen by their authors), with the common filters and review status.
class TaskReportsScreen extends ConsumerWidget {
  const TaskReportsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final query = ref.watch(reportsQueryProvider);
    final setQuery = ref.read(reportsQueryProvider.notifier).set;
    return Scaffold(
      appBar: AppBar(title: const Text(TasksCopy.reportsTitle)),
      body: SafeArea(
        top: false,
        child: TasksPagedList<ReportSummary>(
          value: ref.watch(reportsProvider),
          onRefresh: () => ref.read(reportsProvider.notifier).refresh(),
          onLoadMore: () => ref.read(reportsProvider.notifier).loadMore(),
          onRetry: () => ref.invalidate(reportsProvider),
          emptyIcon: Icons.description_outlined,
          emptyTitle: TasksCopy.reportsEmpty,
          emptyMessage: TasksCopy.reportsEmptyMessage,
          header: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Wrap(
                spacing: Insets.sm,
                runSpacing: Insets.xs,
                children: [
                  for (final category in ReportCategory.selectable)
                    ChoiceChip(
                      key: Key('reports-category-${category.wire}'),
                      label: Text(TasksLabels.category(category)),
                      selected: query.category == category,
                      onSelected: (_) => setQuery((category: category, filter: query.filter)),
                    ),
                ],
              ),
              const SizedBox(height: Insets.md),
              TaskFilterBar(
                filter: query.filter,
                showState: false,
                showReportStatus: true,
                onChanged: (filter) => setQuery((category: query.category, filter: filter)),
              ),
            ],
          ),
          itemBuilder: (context, summary) => _ReportCard(summary: summary),
        ),
      ),
    );
  }
}

class _ReportCard extends StatelessWidget {
  const _ReportCard({required this.summary});

  final ReportSummary summary;

  @override
  Widget build(BuildContext context) {
    final report = summary.report;
    return AppCard(
      key: Key('report-${report.id}'),
      onTap: () => context.push(Routes.taskReport(report.id)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(summary.taskTitle, style: context.text.titleSmall)),
              TaskPill.report(report.status),
            ],
          ),
          const SizedBox(height: Insets.xs),
          Text(
            '${TaskFormat.person(report.author)} · ${TasksLabels.audience(summary.audience)} · '
            '${TasksCopy.versionLine(report.version)} · ${TaskFormat.when(report.updatedAt)}',
            style: context.text.bodySmall,
          ),
        ],
      ),
    );
  }
}
