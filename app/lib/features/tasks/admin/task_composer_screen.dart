import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../core/widgets/foundations/empty_state.dart';
import '../../../core/widgets/layout/responsive_body.dart';
import '../../../data/models/communities.dart';
import '../../../data/models/tasks/tasks.dart';
import '../../../providers/app_providers.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/task_admin_actions.dart';
import '../state/task_admin_state.dart';
import '../state/tasks_permissions.dart';
import '../widgets/task_feedback.dart';
import 'task_form_sections.dart';
import 'task_form_values.dart';

/// What the composer is for.
enum ComposerMode { create, edit, republish }

/// The communities the composer may narrow a task to — the viewer's own; the
/// server checks the community exists when the task is published.
final _composerCommunitiesProvider = FutureProvider.autoDispose<List<Community>>((ref) async {
  final page = await ref.watch(communityRepositoryProvider).communities();
  return page.items;
});

/// Publishing a task, editing one, or re-publishing a past one as a new,
/// independent task (ADR 0052 §3, §7, §8). An edit or a re-publish starts from
/// the task as the server has it now; a template, from the owner's template.
class TaskComposerScreen extends ConsumerWidget {
  const TaskComposerScreen({super.key, required this.mode, this.taskId, this.template})
    : assert(mode == ComposerMode.create || taskId != null);

  final ComposerMode mode;
  final String? taskId;
  final TaskTemplate? template;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final title = switch (mode) {
      ComposerMode.create => TasksCopy.composeTitle,
      ComposerMode.edit => TasksCopy.editTitle,
      ComposerMode.republish => TasksCopy.republishTitle,
    };
    final communities = ref.watch(_composerCommunitiesProvider).value ?? const <Community>[];
    final Widget body;
    if (mode == ComposerMode.create) {
      body = _Composer(
        mode: mode,
        source: null,
        initial: template == null ? TaskFormValues() : TaskFormValues.ofTemplate(template!),
        communities: communities,
      );
    } else {
      final provider = taskDetailProvider(taskId!);
      body = AsyncView<TaskDetail>(
        value: ref.watch(provider),
        onRetry: () => ref.invalidate(provider),
        errorBuilder: (context, error) => EmptyState(
          icon: Icons.error_outline,
          title: TasksLabels.error(error),
          actionLabel: TasksCopy.refresh,
          onAction: () => ref.invalidate(provider),
        ),
        builder: (context, detail) => _Composer(
          key: ValueKey('composer-${detail.task.id}-${detail.task.revision}'),
          mode: mode,
          source: detail,
          initial: TaskFormValues.ofTask(detail.task),
          communities: communities,
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(top: false, child: body),
    );
  }
}

class _Composer extends ConsumerStatefulWidget {
  const _Composer({
    super.key,
    required this.mode,
    required this.source,
    required this.initial,
    required this.communities,
  });

  final ComposerMode mode;
  final TaskDetail? source;
  final TaskFormValues initial;
  final List<Community> communities;

  @override
  ConsumerState<_Composer> createState() => _ComposerState();
}

class _ComposerState extends ConsumerState<_Composer> {
  late final TaskFormValues _values = widget.initial;
  late final _title = TextEditingController(text: _values.title);
  late final _body = TextEditingController(text: _values.body);

  /// Minted once per composer: a retried tap publishes once.
  final String _requestId = TaskAdminActions.newRequestId();
  bool _reacknowledge = false;
  bool _busy = false;

  bool get _editing => widget.mode == ComposerMode.edit;

  /// Settings are locked once anyone has responded (the server says so too).
  bool get _settingsLocked => _editing && (widget.source?.counts.responded ?? 0) > 0;

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  bool _ready() {
    _values
      ..title = _title.text
      ..body = _body.text;
    final problem = _values.problem(needsAudience: !_editing);
    if (problem == null) return true;
    final message = switch (problem) {
      FormProblem.title => TasksCopy.titleMissing,
      FormProblem.audience => TasksCopy.audienceMissing,
      FormProblem.response => TasksCopy.noResponseWay,
    };
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
    return false;
  }

  Future<void> _submit() async {
    if (!_ready()) return;
    final actions = ref.read(taskAdminActionsProvider);
    final router = GoRouter.of(context);
    setState(() => _busy = true);
    final source = widget.source;
    TaskItem? landed;
    final ok = await runTaskAct<TaskItem>(
      context,
      () async => landed = switch (widget.mode) {
        ComposerMode.create => await actions.publish(_values.toDraft(), clientRequestId: _requestId),
        ComposerMode.edit => await actions.edit(
          source!.task.id,
          _values.toEdit(source.task, requireReacknowledge: _reacknowledge),
        ),
        ComposerMode.republish => await actions.republish(
          source!.task.id,
          _values.toDraft(),
          clientRequestId: _requestId,
        ),
      },
      success: switch (widget.mode) {
        ComposerMode.create => TasksCopy.published,
        ComposerMode.edit => TasksCopy.edited,
        ComposerMode.republish => TasksCopy.republished,
      },
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok || landed == null) return;
    if (_editing) {
      router.pop();
    } else {
      router.pushReplacement(Routes.task(landed!.id));
    }
  }

  Future<void> _saveTemplate() async {
    if (!_ready()) return;
    setState(() => _busy = true);
    await runTaskAct(
      context,
      () => ref.read(taskAdminActionsProvider).saveTemplateFromDraft(_values.toDraft()),
      success: TasksCopy.templateSaved,
    );
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final templates = ref.watch(canUseTaskTemplatesProvider);
    final submitLabel = switch (widget.mode) {
      ComposerMode.create => TasksCopy.publish,
      ComposerMode.edit => TasksCopy.saveEdit,
      ComposerMode.republish => TasksCopy.republish,
    };
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: Insets.lg),
      children: [
        ResponsiveBody(
          child: AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  key: const Key('task-form-title'),
                  controller: _title,
                  maxLength: 200,
                  decoration: const InputDecoration(
                    labelText: TasksCopy.titleField,
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: Insets.sm),
                TextField(
                  key: const Key('task-form-body'),
                  controller: _body,
                  minLines: 3,
                  maxLines: 12,
                  maxLength: 10000,
                  decoration: const InputDecoration(
                    labelText: TasksCopy.bodyField,
                    border: OutlineInputBorder(),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: Insets.md),
        ResponsiveBody(
          child: AppCard(
            child: AudienceSection(
              values: _values,
              communities: widget.communities,
              // A published task keeps its addressees; reassign one instead.
              enabled: !_editing && !_busy,
              onChanged: () => setState(() {}),
            ),
          ),
        ),
        const SizedBox(height: Insets.md),
        ResponsiveBody(
          child: AppCard(
            child: SettingsSection(
              values: _values,
              locked: _settingsLocked || _busy,
              onChanged: () => setState(() {}),
            ),
          ),
        ),
        if (_editing)
          ResponsiveBody(
            child: CheckboxListTile(
              key: const Key('task-form-reacknowledge'),
              contentPadding: EdgeInsets.zero,
              value: _reacknowledge,
              onChanged: _busy ? null : (on) => setState(() => _reacknowledge = on ?? false),
              title: const Text(TasksCopy.requireReacknowledge),
            ),
          ),
        const SizedBox(height: Insets.lg),
        ResponsiveBody(
          child: FilledButton(
            key: const Key('task-form-submit'),
            onPressed: _busy ? null : _submit,
            child: Text(submitLabel),
          ),
        ),
        if (templates && widget.mode == ComposerMode.create)
          ResponsiveBody(
            child: TextButton.icon(
              key: const Key('task-form-save-template'),
              onPressed: _busy ? null : _saveTemplate,
              icon: const Icon(Icons.bookmark_add_outlined),
              label: const Text(TasksCopy.saveAsTemplate),
            ),
          ),
      ],
    );
  }
}
