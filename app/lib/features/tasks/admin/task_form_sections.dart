import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/communities.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import 'task_form_values.dart';

/// Who the task goes to: one or more audiences, optionally narrowed to the
/// members of one community.
class AudienceSection extends StatelessWidget {
  const AudienceSection({
    super.key,
    required this.values,
    required this.communities,
    required this.enabled,
    required this.onChanged,
  });

  final TaskFormValues values;
  final List<Community> communities;
  final bool enabled;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final known = communities.any((c) => c.id == values.communityId);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(TasksCopy.audiencesField, style: context.text.labelLarge),
        const SizedBox(height: Insets.xs),
        Wrap(
          spacing: Insets.sm,
          children: [
            for (final audience in TaskAudience.selectable)
              FilterChip(
                key: Key('task-form-audience-${audience.wire}'),
                label: Text(TasksLabels.audience(audience)),
                selected: values.audiences.contains(audience),
                onSelected: enabled
                    ? (on) {
                        on ? values.audiences.add(audience) : values.audiences.remove(audience);
                        onChanged();
                      }
                    : null,
              ),
          ],
        ),
        const SizedBox(height: Insets.md),
        DropdownButtonFormField<String?>(
          key: const Key('task-form-community'),
          initialValue: known ? values.communityId : null,
          decoration: const InputDecoration(
            labelText: TasksCopy.communityField,
            border: OutlineInputBorder(),
          ),
          items: [
            const DropdownMenuItem<String?>(child: Text(TasksCopy.communityNone)),
            for (final community in communities)
              DropdownMenuItem<String?>(value: community.id, child: Text(community.title)),
          ],
          onChanged: enabled
              ? (id) {
                  values.communityId = id;
                  onChanged();
                }
              : null,
        ),
      ],
    );
  }
}

/// How recipients answer and how reports are judged: kind, buttons, a
/// required report, approval. Locked once anyone has responded.
class SettingsSection extends StatelessWidget {
  const SettingsSection({
    super.key,
    required this.values,
    required this.locked,
    required this.onChanged,
  });

  final TaskFormValues values;
  final bool locked;
  final VoidCallback onChanged;

  void _set(void Function() change) {
    change();
    onChanged();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (locked)
          Padding(
            padding: const EdgeInsets.only(bottom: Insets.sm),
            child: Text(TasksCopy.settingsLockedHint, style: context.text.bodySmall),
          ),
        DropdownButtonFormField<TaskKind>(
          key: const Key('task-form-kind'),
          initialValue: TaskKind.selectable.contains(values.kind) ? values.kind : null,
          decoration: const InputDecoration(
            labelText: TasksCopy.kindField,
            border: OutlineInputBorder(),
          ),
          items: [
            for (final kind in TaskKind.selectable)
              DropdownMenuItem(value: kind, child: Text(TasksLabels.kind(kind))),
          ],
          onChanged: locked ? null : (kind) => _set(() => values.kind = kind ?? values.kind),
        ),
        const SizedBox(height: Insets.md),
        Text(TasksCopy.buttonsField, style: context.text.labelLarge),
        Wrap(
          spacing: Insets.sm,
          children: [
            for (final button in TaskButton.selectable)
              FilterChip(
                key: Key('task-form-button-${button.wire}'),
                label: Text(TasksLabels.button(button)),
                selected: values.buttons.contains(button),
                onSelected: locked
                    ? null
                    : (on) => _set(
                        () => on ? values.buttons.add(button) : values.buttons.remove(button),
                      ),
              ),
          ],
        ),
        SwitchListTile.adaptive(
          key: const Key('task-form-report-required'),
          contentPadding: EdgeInsets.zero,
          title: const Text(TasksCopy.reportRequired),
          value: values.reportRequired,
          onChanged: locked ? null : (on) => _set(() => values.reportRequired = on),
        ),
        if (values.reportRequired)
          DropdownButtonFormField<ApprovalMode>(
            key: const Key('task-form-approval'),
            initialValue: ApprovalMode.selectable.contains(values.approvalMode)
                ? values.approvalMode
                : null,
            decoration: const InputDecoration(
              labelText: TasksCopy.approvalField,
              border: OutlineInputBorder(),
            ),
            items: [
              for (final mode in ApprovalMode.selectable)
                DropdownMenuItem(value: mode, child: Text(TasksLabels.approval(mode))),
            ],
            onChanged: locked
                ? null
                : (mode) => _set(() => values.approvalMode = mode ?? values.approvalMode),
          ),
      ],
    );
  }
}
