import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/academic.dart';
import '../../providers/app_providers.dart';
import 'academic_admin_copy.dart';
import 'state/program_halaqat_controller.dart';
import 'widgets/structure_form_sheet.dart';

/// A program's halaqat, for a holder of `academic.manage`: create one, rename or
/// reorder it, and activate or deactivate it. The server re-authorises every
/// write and refuses to deactivate a halaqa that still has active enrolments —
/// said here in words, never worked around. Enrolling students is not offered;
/// it needs the unresolved people-discovery policy and stays a server act.
class ProgramHalaqatScreen extends ConsumerWidget {
  const ProgramHalaqatScreen({super.key, required this.programId});

  final String programId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canManage = ref.watch(
      sessionUserProvider.select(
        (session) => session.value?.can('academic.manage') ?? false,
      ),
    );
    final detail = ref.watch(programHalaqatProvider(programId));
    final title = detail.value?.program.name ?? AcademicAdminCopy.manageHalaqat;
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [
          IconButton(
            tooltip: AcademicAdminCopy.refresh,
            onPressed: () => ref.invalidate(programHalaqatProvider(programId)),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      floatingActionButton: canManage && detail.hasValue
          ? FloatingActionButton.extended(
              key: const Key('academic-add-halaqa-fab'),
              onPressed: () => _createHalaqa(context, ref, programId),
              icon: const Icon(Icons.add),
              label: const Text(AcademicAdminCopy.addHalaqa),
            )
          : null,
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: detail,
          onRetry: () => ref.invalidate(programHalaqatProvider(programId)),
          builder: (context, data) {
            if (data.halaqat.isEmpty) {
              return const SingleChildScrollView(
                child: EmptyState(
                  icon: Icons.groups_2_outlined,
                  title: AcademicAdminCopy.noHalaqat,
                  message: AcademicAdminCopy.noHalaqat,
                ),
              );
            }
            return RefreshIndicator(
              onRefresh: () => ref
                  .read(programHalaqatProvider(programId).notifier)
                  .refresh(),
              child: ListView.builder(
                padding: const EdgeInsets.only(
                  top: Insets.md,
                  bottom: Insets.giant,
                ),
                itemCount: data.halaqat.length,
                itemBuilder: (context, index) => ResponsiveBody(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: Insets.sm),
                    child: _HalaqaCard(
                      programId: programId,
                      halaqa: data.halaqat[index],
                      canManage: canManage,
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _HalaqaCard extends ConsumerWidget {
  const _HalaqaCard({
    required this.programId,
    required this.halaqa,
    required this.canManage,
  });

  final String programId;
  final AcademicHalaqa halaqa;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dimmed = !halaqa.isActive;
    final color = dimmed ? context.colors.onSurfaceVariant : null;
    return AppCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.menu_book_outlined,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  halaqa.name,
                  style: context.text.titleSmall?.copyWith(color: color),
                ),
                const SizedBox(height: 2),
                Text(
                  '${halaqa.code} · ${AcademicAdminCopy.status(halaqa.status)}',
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          if (canManage)
            PopupMenuButton<String>(
              icon: const Icon(Icons.more_vert),
              onSelected: (value) => switch (value) {
                'people' => context.push(
                  Routes.academicHalaqaPeople(halaqa.id),
                ),
                'edit' => _editHalaqa(context, ref, programId, halaqa),
                _ => _setHalaqaActive(
                  context,
                  ref,
                  programId,
                  halaqa,
                  !halaqa.isActive,
                ),
              },
              itemBuilder: (context) => [
                const PopupMenuItem(
                  value: 'people',
                  child: Text(AcademicAdminCopy.managePeople),
                ),
                const PopupMenuItem(
                  value: 'edit',
                  child: Text(AcademicAdminCopy.edit),
                ),
                PopupMenuItem(
                  value: 'toggle',
                  child: Text(
                    halaqa.isActive
                        ? AcademicAdminCopy.deactivate
                        : AcademicAdminCopy.activate,
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

// ── Actions ──────────────────────────────────────────────────────────────

void _createHalaqa(BuildContext context, WidgetRef ref, String programId) {
  showStructureForm(
    context,
    spec: StructureFormSpec(
      title: AcademicAdminCopy.createHalaqaTitle,
      submitLabel: AcademicAdminCopy.createAction,
      successMessage: AcademicAdminCopy.created,
      showCode: true,
      onSubmit: (v) => ref
          .read(programHalaqatProvider(programId).notifier)
          .createHalaqa(code: v.code!, name: v.name, order: v.order),
    ),
  );
}

void _editHalaqa(
  BuildContext context,
  WidgetRef ref,
  String programId,
  AcademicHalaqa h,
) {
  showStructureForm(
    context,
    spec: StructureFormSpec(
      title: AcademicAdminCopy.editTitle(h.name),
      submitLabel: AcademicAdminCopy.saveAction,
      successMessage: AcademicAdminCopy.saved,
      initialName: h.name,
      initialOrder: h.order,
      onSubmit: (v) => ref
          .read(programHalaqatProvider(programId).notifier)
          .updateHalaqa(h.id, name: v.name, order: v.order),
    ),
  );
}

/// Activate at once; deactivate only after asking. The server may still refuse
/// a deactivate (a halaqa with active enrolments) — that is said in words.
Future<void> _setHalaqaActive(
  BuildContext context,
  WidgetRef ref,
  String programId,
  AcademicHalaqa h,
  bool active,
) async {
  final messenger = ScaffoldMessenger.of(context);
  if (!active) {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(
          AcademicAdminCopy.deactivateQuestion(
            AcademicAdminCopy.halaqaWord,
            h.name,
          ),
        ),
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
    if (confirmed != true) return;
  }
  try {
    await ref
        .read(programHalaqatProvider(programId).notifier)
        .setHalaqaActive(h.id, active: active);
  } on AcademicException catch (error) {
    messenger.toast(AcademicAdminCopy.changeFailed(error.code));
    return;
  }
  messenger.toast(
    active ? AcademicAdminCopy.activated : AcademicAdminCopy.deactivated,
  );
}
