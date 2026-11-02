import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../core/widgets/foundations/empty_state.dart';
import '../../../core/widgets/foundations/section_header.dart';
import '../../../core/widgets/layout/responsive_body.dart';
import '../../../data/models/communities.dart';
import '../../../data/models/tasks/tasks.dart';
import '../../../providers/app_providers.dart';
import '../../auth/sign_in_prompt.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/task_insights_state.dart';
import '../widgets/task_filter_bar.dart';
import 'task_export_buttons.dart';
import 'task_totals_view.dart';

/// The viewer's own communities, to name the dashboard's community groups.
final _communityNamesProvider = FutureProvider.autoDispose<Map<String, String>>((ref) async {
  final page = await ref.watch(communityRepositoryProvider).communities();
  return {for (final Community c in page.items) c.id: c.title};
});

/// «إحصاءات المهام» (roadmap §12): rates and counts under the common filters,
/// compared by audience, by community and per person — people alphabetically,
/// never ranked — and the export of the same selection.
class TaskDashboardScreen extends ConsumerWidget {
  const TaskDashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final filter = ref.watch(dashboardFilterProvider);
    void retry() => ref.invalidate(taskDashboardProvider);
    final names = ref.watch(_communityNamesProvider).value ?? const {};
    return Scaffold(
      appBar: AppBar(
        title: const Text(TasksCopy.dashboardTitle),
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
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: Insets.lg),
          children: [
            ResponsiveBody(
              child: TaskFilterBar(
                filter: filter,
                showReportStatus: true,
                onChanged: ref.read(dashboardFilterProvider.notifier).set,
              ),
            ),
            ResponsiveBody(child: TaskExportButtons(filter: filter)),
            const SizedBox(height: Insets.lg),
            AsyncView<TaskDashboard>(
              value: ref.watch(taskDashboardProvider),
              onRetry: retry,
              errorBuilder: (context, error) =>
                  SignInPrompt.forError(error, onReturn: retry) ??
                  EmptyState(
                    icon: Icons.error_outline,
                    title: TasksLabels.error(error),
                    actionLabel: TasksCopy.refresh,
                    onAction: retry,
                  ),
              builder: (context, board) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const ResponsiveBody(child: SectionHeader(title: TasksCopy.totalsSection)),
                  ResponsiveBody(child: TaskTotalsView(totals: board.totals)),
                  ..._groups(
                    TasksCopy.byAudienceSection,
                    board.byAudience,
                    (g) => TasksLabels.audienceWire(g.key),
                  ),
                  ..._groups(
                    TasksCopy.byCommunitySection,
                    board.byCommunity,
                    (g) => names[g.key] ?? TasksCopy.unknownCommunity,
                  ),
                  if (board.byPerson.isNotEmpty)
                    ResponsiveBody(
                      child: Padding(
                        padding: const EdgeInsets.only(top: Insets.lg),
                        child: Text(TasksCopy.byPersonHint, style: context.text.bodySmall),
                      ),
                    ),
                  ..._groups(
                    TasksCopy.byPersonSection,
                    board.byPerson,
                    (g) => g.label ?? TasksCopy.unknownPerson,
                    showTasks: false,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _groups(
    String title,
    List<TaskTotalsGroup> groups,
    String Function(TaskTotalsGroup) labelOf, {
    bool showTasks = true,
  }) {
    if (groups.isEmpty) return const [];
    return [
      const SizedBox(height: Insets.lg),
      ResponsiveBody(child: SectionHeader(title: title)),
      for (final group in groups)
        ResponsiveBody(
          child: Padding(
            padding: const EdgeInsets.only(bottom: Insets.sm),
            child: TaskTotalsView(
              key: Key('dashboard-group-${group.key}'),
              title: labelOf(group),
              totals: group.totals,
              showTasks: showTasks,
            ),
          ),
        ),
    ];
  }
}
