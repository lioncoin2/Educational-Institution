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
import '../state/task_reports_state.dart';
import '../widgets/review_notes.dart';
import '../widgets/task_format.dart';
import '../widgets/task_pill.dart';
import 'report_review_panel.dart';

/// One report as its reviewer sees it: the task it answers, its current text,
/// who approved it and when, every kept version and every review.
class TaskReportScreen extends ConsumerWidget {
  const TaskReportScreen({super.key, required this.reportId});

  final String reportId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = reportDetailProvider(reportId);
    void retry() => ref.invalidate(provider);
    return Scaffold(
      appBar: AppBar(title: const Text(TasksCopy.reportsTitle)),
      body: SafeArea(
        top: false,
        child: AsyncView<ReportDetail>(
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
          builder: (context, detail) => ListView(
            padding: const EdgeInsets.symmetric(vertical: Insets.lg),
            children: [
              ResponsiveBody(child: _Head(detail: detail)),
              const SizedBox(height: Insets.md),
              ResponsiveBody(child: ReportReviewPanel(detail: detail)),
              if (detail.reviews.isNotEmpty) ...[
                const SizedBox(height: Insets.lg),
                const ResponsiveBody(child: SectionHeader(title: TasksCopy.reviews)),
                ResponsiveBody(child: AppCard(child: ReviewNotes(reviews: detail.reviews))),
              ],
              if (detail.versions.length > 1) ...[
                const SizedBox(height: Insets.lg),
                const ResponsiveBody(child: SectionHeader(title: TasksCopy.versions)),
                for (final version in detail.versions.reversed)
                  ResponsiveBody(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: Insets.sm),
                      child: AppCard(
                        key: Key('report-version-${version.version}'),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${TasksCopy.versionLine(version.version)} · '
                              '${TaskFormat.person(version.editedBy)} · '
                              '${TaskFormat.when(version.editedAt)}',
                              style: context.text.labelMedium,
                            ),
                            const SizedBox(height: Insets.xs),
                            SelectableText(version.body),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Head extends StatelessWidget {
  const _Head({required this.detail});

  final ReportDetail detail;

  @override
  Widget build(BuildContext context) {
    final report = detail.report;
    final approval = switch ((report.approvedAt, report.approvedBy)) {
      (null, _) => null,
      (final at?, null) => '${TasksCopy.approvedAutomatically} · ${TaskFormat.when(at)}',
      (final at?, final who?) => '${TasksCopy.approvedBy(TaskFormat.person(who))} · ${TaskFormat.when(at)}',
    };
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(detail.task.title, style: context.text.titleMedium)),
              TaskPill.report(report.status),
            ],
          ),
          const SizedBox(height: Insets.xs),
          Text(
            '${TaskFormat.person(report.author)} · ${TasksLabels.category(report.category)} · '
            '${TasksCopy.versionLine(report.version)}',
            style: context.text.bodySmall,
          ),
          if (approval != null) Text(approval, style: context.text.bodySmall),
          if (detail.latest case final latest?) ...[
            const SizedBox(height: Insets.md),
            SelectableText(latest.body, style: context.text.bodyMedium),
          ],
        ],
      ),
    );
  }
}
