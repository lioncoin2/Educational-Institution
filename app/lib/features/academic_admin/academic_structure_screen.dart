import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/academic.dart';
import '../../providers/app_providers.dart';
import 'academic_admin_copy.dart';
import 'state/academic_structure_controller.dart';
import 'widgets/structure_form_sheet.dart';

/// إدارة الهيكل الأكاديمي — the institution's sections and their programs, for a
/// holder of `academic.manage`. Create and edit sections and programs here,
/// activate or deactivate them (structure is never deleted), and open a program
/// to manage its halaqat. The server re-authorises every read and every write;
/// a hidden control is a courtesy, never the authorization.
class AcademicStructureScreen extends ConsumerWidget {
  const AcademicStructureScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canManage = ref.watch(
      sessionUserProvider.select(
        (session) => session.value?.can('academic.manage') ?? false,
      ),
    );
    return Scaffold(
      appBar: AppBar(
        title: const Text(AcademicAdminCopy.screenTitle),
        actions: [
          IconButton(
            tooltip: AcademicAdminCopy.refresh,
            onPressed: () => ref.invalidate(academicStructureProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              key: const Key('academic-add-section-fab'),
              onPressed: () => _createSection(context, ref),
              icon: const Icon(Icons.add),
              label: const Text(AcademicAdminCopy.addSection),
            )
          : null,
      body: SafeArea(top: false, child: _StructureList(canManage: canManage)),
    );
  }
}

class _StructureList extends ConsumerWidget {
  const _StructureList({required this.canManage});

  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sections = ref.watch(academicStructureProvider);
    final demo = !ref.watch(backendModeProvider);
    return AsyncView(
      value: sections,
      onRetry: () => ref.invalidate(academicStructureProvider),
      builder: (context, items) {
        if (items.isEmpty) {
          return const SingleChildScrollView(
            child: EmptyState(
              icon: Icons.account_tree_outlined,
              title: AcademicAdminCopy.empty,
              message: AcademicAdminCopy.emptyMessage,
            ),
          );
        }
        return RefreshIndicator(
          onRefresh: () =>
              ref.read(academicStructureProvider.notifier).refresh(),
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: Insets.giant),
            itemCount: items.length + 1,
            itemBuilder: (context, index) {
              if (index == 0) {
                return demo
                    ? const ResponsiveBody(
                        child: Padding(
                          padding: EdgeInsets.symmetric(vertical: Insets.md),
                          child: MockBanner(
                            message: AcademicAdminCopy.demoBanner,
                          ),
                        ),
                      )
                    : const SizedBox(height: Insets.md);
              }
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.sm),
                  child: _SectionCard(
                    section: items[index - 1],
                    canManage: canManage,
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }
}

class _SectionCard extends ConsumerWidget {
  const _SectionCard({required this.section, required this.canManage});

  final AcademicSection section;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final subtitle =
        '${AcademicAdminCopy.kind(section.kind)} · '
        '${AcademicAdminCopy.status(section.status)} · '
        '${AcademicAdminCopy.activeHalaqat(section.activeHalaqaCount)}';
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Header(
            icon: Icons.account_tree_outlined,
            title: section.name,
            code: section.code,
            subtitle: subtitle,
            dimmed: !section.isActive,
            menu: canManage
                ? _StructureMenu(
                    active: section.isActive,
                    onEdit: () => _editSection(context, ref, section),
                    onToggle: () => _setSectionActive(
                      context,
                      ref,
                      section,
                      !section.isActive,
                    ),
                  )
                : null,
          ),
          const SizedBox(height: Insets.sm),
          if (section.programs.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: Insets.sm),
              child: Text(AcademicAdminCopy.noPrograms),
            )
          else
            for (final program in section.programs)
              _ProgramRow(program: program, canManage: canManage),
          if (canManage) ...[
            const SizedBox(height: Insets.xs),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton.icon(
                onPressed: () => _createProgram(context, ref, section),
                icon: const Icon(Icons.add, size: 18),
                label: const Text(AcademicAdminCopy.addProgram),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _ProgramRow extends ConsumerWidget {
  const _ProgramRow({required this.program, required this.canManage});

  final AcademicProgram program;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dimmed = !program.isActive;
    final color = dimmed ? context.colors.onSurfaceVariant : null;
    return ListTile(
      contentPadding: const EdgeInsetsDirectional.only(start: Insets.md),
      onTap: () => context.push(Routes.academicProgram(program.id)),
      title: Text(
        program.name,
        style: context.text.titleSmall?.copyWith(color: color),
      ),
      subtitle: Text(
        '${program.code} · ${AcademicAdminCopy.status(program.status)} · '
        '${AcademicAdminCopy.activeHalaqat(program.activeHalaqaCount)}',
        style: context.text.bodySmall?.copyWith(
          color: context.colors.onSurfaceVariant,
        ),
      ),
      trailing: canManage
          ? _StructureMenu(
              active: program.isActive,
              extra: [
                (
                  value: 'halaqat',
                  icon: Icons.groups_2_outlined,
                  label: AcademicAdminCopy.manageHalaqat,
                ),
              ],
              onExtra: (_) => context.push(Routes.academicProgram(program.id)),
              onEdit: () => _editProgram(context, ref, program),
              onToggle: () =>
                  _setProgramActive(context, ref, program, !program.isActive),
            )
          : const Icon(Icons.chevron_right_rounded),
    );
  }
}

/// A section/program header: an icon, a name with its code, a one-line subtitle,
/// and an optional overflow menu.
class _Header extends StatelessWidget {
  const _Header({
    required this.icon,
    required this.title,
    required this.code,
    required this.subtitle,
    required this.dimmed,
    this.menu,
  });

  final IconData icon;
  final String title;
  final String code;
  final String subtitle;
  final bool dimmed;
  final Widget? menu;

  @override
  Widget build(BuildContext context) {
    final color = dimmed ? context.colors.onSurfaceVariant : null;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: context.colors.onSurfaceVariant),
        const SizedBox(width: Insets.md),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: context.text.titleMedium?.copyWith(color: color),
              ),
              const SizedBox(height: 2),
              Text(
                code,
                style: context.text.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 2),
              Text(subtitle, style: context.text.bodySmall),
            ],
          ),
        ),
        ?menu,
      ],
    );
  }
}

typedef _MenuExtra = ({String value, IconData icon, String label});

/// The edit / activate / deactivate overflow, with optional extra items (a
/// program adds "manage halaqat"). The deactivate item carries a distinct value
/// so the confirm step runs only for it.
class _StructureMenu extends StatelessWidget {
  const _StructureMenu({
    required this.active,
    required this.onEdit,
    required this.onToggle,
    this.extra = const [],
    this.onExtra,
  });

  final bool active;
  final VoidCallback onEdit;
  final VoidCallback onToggle;
  final List<_MenuExtra> extra;
  final void Function(String value)? onExtra;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      icon: const Icon(Icons.more_vert),
      onSelected: (value) => switch (value) {
        'edit' => onEdit(),
        'toggle' => onToggle(),
        _ => onExtra?.call(value),
      },
      itemBuilder: (context) => [
        for (final item in extra)
          PopupMenuItem(
            value: item.value,
            child: _MenuTile(icon: item.icon, label: item.label),
          ),
        const PopupMenuItem(
          value: 'edit',
          child: _MenuTile(
            icon: Icons.edit_outlined,
            label: AcademicAdminCopy.edit,
          ),
        ),
        PopupMenuItem(
          value: 'toggle',
          child: _MenuTile(
            icon: active ? Icons.block_outlined : Icons.check_circle_outline,
            label: active
                ? AcademicAdminCopy.deactivate
                : AcademicAdminCopy.activate,
          ),
        ),
      ],
    );
  }
}

class _MenuTile extends StatelessWidget {
  const _MenuTile({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 20, color: context.colors.onSurfaceVariant),
        const SizedBox(width: Insets.md),
        Text(label),
      ],
    );
  }
}

// ── Actions ──────────────────────────────────────────────────────────────

void _createSection(BuildContext context, WidgetRef ref) {
  showStructureForm(
    context,
    spec: StructureFormSpec(
      title: AcademicAdminCopy.createSectionTitle,
      submitLabel: AcademicAdminCopy.createAction,
      successMessage: AcademicAdminCopy.created,
      showCode: true,
      showKind: true,
      showDescription: true,
      onSubmit: (v) => ref
          .read(academicStructureProvider.notifier)
          .createSection(
            code: v.code!,
            name: v.name,
            order: v.order,
            kind: v.kind!,
            description: v.description,
          ),
    ),
  );
}

void _editSection(BuildContext context, WidgetRef ref, AcademicSection s) {
  showStructureForm(
    context,
    spec: StructureFormSpec(
      title: AcademicAdminCopy.editTitle(s.name),
      submitLabel: AcademicAdminCopy.saveAction,
      successMessage: AcademicAdminCopy.saved,
      showDescription: true,
      initialName: s.name,
      initialOrder: s.order,
      initialDescription: s.description,
      onSubmit: (v) => ref
          .read(academicStructureProvider.notifier)
          .updateSection(
            s.id,
            name: v.name,
            order: v.order,
            description: v.description,
          ),
    ),
  );
}

void _createProgram(BuildContext context, WidgetRef ref, AcademicSection s) {
  showStructureForm(
    context,
    spec: StructureFormSpec(
      title: AcademicAdminCopy.createProgramTitle,
      submitLabel: AcademicAdminCopy.createAction,
      successMessage: AcademicAdminCopy.created,
      showCode: true,
      showDescription: true,
      onSubmit: (v) => ref
          .read(academicStructureProvider.notifier)
          .createProgram(
            sectionId: s.id,
            code: v.code!,
            name: v.name,
            order: v.order,
            description: v.description,
          ),
    ),
  );
}

void _editProgram(BuildContext context, WidgetRef ref, AcademicProgram p) {
  showStructureForm(
    context,
    spec: StructureFormSpec(
      title: AcademicAdminCopy.editTitle(p.name),
      submitLabel: AcademicAdminCopy.saveAction,
      successMessage: AcademicAdminCopy.saved,
      showDescription: true,
      initialName: p.name,
      initialOrder: p.order,
      initialDescription: p.description,
      onSubmit: (v) => ref
          .read(academicStructureProvider.notifier)
          .updateProgram(
            p.id,
            name: v.name,
            order: v.order,
            description: v.description,
          ),
    ),
  );
}

Future<void> _setSectionActive(
  BuildContext context,
  WidgetRef ref,
  AcademicSection s,
  bool active,
) async {
  await _applyActive(
    context,
    entity: AcademicAdminCopy.sectionWord,
    name: s.name,
    active: active,
    write: () => ref
        .read(academicStructureProvider.notifier)
        .setSectionActive(s.id, active: active),
  );
}

Future<void> _setProgramActive(
  BuildContext context,
  WidgetRef ref,
  AcademicProgram p,
  bool active,
) async {
  await _applyActive(
    context,
    entity: AcademicAdminCopy.programWord,
    name: p.name,
    active: active,
    write: () => ref
        .read(academicStructureProvider.notifier)
        .setProgramActive(p.id, active: active),
  );
}

/// Activate at once; deactivate only after asking (it preserves history, never
/// deletes). The write throws [AcademicException] on refusal; either way the
/// outcome is said in words.
Future<void> _applyActive(
  BuildContext context, {
  required String entity,
  required String name,
  required bool active,
  required Future<void> Function() write,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  if (!active) {
    final confirmed = await _confirmDeactivate(context, entity, name);
    if (confirmed != true) return;
  }
  try {
    await write();
  } on AcademicException catch (error) {
    messenger.toast(AcademicAdminCopy.changeFailed(error.code));
    return;
  }
  messenger.toast(
    active ? AcademicAdminCopy.activated : AcademicAdminCopy.deactivated,
  );
}

Future<bool?> _confirmDeactivate(
  BuildContext context,
  String entity,
  String name,
) {
  return showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      content: Text(AcademicAdminCopy.deactivateQuestion(entity, name)),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text(AcademicAdminCopy.cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text(AcademicAdminCopy.confirmDeactivate),
        ),
      ],
    ),
  );
}
