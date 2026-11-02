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
import '../state/task_admin_actions.dart';
import '../state/task_templates_state.dart';
import '../state/tasks_permissions.dart';
import '../widgets/task_feedback.dart';
import '../widgets/tasks_paged_list.dart';

/// «قوالب المهام» — saved task configurations. Anyone who manages tasks may
/// read them; publishing from one, and keeping or deleting them, is the
/// owner's (`tasks.template`). A task published from a template is independent.
class TaskTemplatesScreen extends ConsumerWidget {
  const TaskTemplatesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text(TasksCopy.templatesTitle)),
      body: SafeArea(
        top: false,
        child: TasksPagedList<TaskTemplate>(
          value: ref.watch(taskTemplatesProvider),
          onRefresh: () => ref.read(taskTemplatesProvider.notifier).refresh(),
          onLoadMore: () => ref.read(taskTemplatesProvider.notifier).loadMore(),
          onRetry: () => ref.invalidate(taskTemplatesProvider),
          emptyIcon: Icons.copy_all_outlined,
          emptyTitle: TasksCopy.templatesEmpty,
          emptyMessage: TasksCopy.templatesEmptyMessage,
          itemBuilder: (context, template) => _TemplateCard(template: template),
        ),
      ),
    );
  }
}

class _TemplateCard extends ConsumerWidget {
  const _TemplateCard({required this.template});

  final TaskTemplate template;

  Future<void> _delete(BuildContext context, WidgetRef ref) async {
    final sure = await confirmTaskAct(
      context,
      title: TasksCopy.deleteTemplate,
      question: TasksCopy.deleteTemplateQuestion,
    );
    if (!sure || !context.mounted) return;
    await runTaskAct(
      context,
      () => ref.read(taskAdminActionsProvider).deleteTemplate(template.id),
      success: TasksCopy.templateDeleted,
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final owner = ref.watch(canUseTaskTemplatesProvider);
    return AppCard(
      key: Key('template-${template.id}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(template.title, style: context.text.titleSmall),
          const SizedBox(height: Insets.xs),
          Text(
            '${template.audiences.map(TasksLabels.audience).join('، ')} · '
            '${TasksLabels.kind(template.kind)}',
            style: context.text.bodySmall,
          ),
          if (owner)
            Row(
              children: [
                TextButton.icon(
                  key: Key('template-use-${template.id}'),
                  onPressed: () => context.push(Routes.taskCompose, extra: template),
                  icon: const Icon(Icons.send_outlined),
                  label: const Text(TasksCopy.useTemplate),
                ),
                const Spacer(),
                IconButton(
                  key: Key('template-delete-${template.id}'),
                  tooltip: TasksCopy.deleteTemplate,
                  onPressed: () => _delete(context, ref),
                  icon: const Icon(Icons.delete_outline),
                ),
              ],
            ),
        ],
      ),
    );
  }
}
