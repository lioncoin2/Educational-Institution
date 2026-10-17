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
import 'state/teacher_assignments_controller.dart';
import 'teacher_copy.dart';

/// حلقاتي كمعلّم — the signed-in teacher's own current halaqat. Read-only: it
/// lists the halaqat the server says this identity actively teaches, and opens
/// each one's student roster. No assignment or enrolment controls, no directory.
class TeacherWorkspaceScreen extends ConsumerWidget {
  const TeacherWorkspaceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspace = ref.watch(teacherAssignmentsProvider);
    final demo = !ref.watch(backendModeProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(TeacherCopy.workspaceTitle),
        actions: [
          IconButton(
            tooltip: TeacherCopy.historyEntry,
            onPressed: () => context.push(Routes.teacherHistory),
            icon: const Icon(Icons.history_edu_outlined),
          ),
          IconButton(
            tooltip: TeacherCopy.refresh,
            onPressed: () => ref.invalidate(teacherAssignmentsProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: workspace,
          onRetry: () => ref.invalidate(teacherAssignmentsProvider),
          errorBuilder: (context, error) => _ErrorView(
            message: TeacherCopy.workspaceFailed(
              error is AcademicException ? error.code : 'unknown',
            ),
            onRetry: () => ref.invalidate(teacherAssignmentsProvider),
          ),
          builder: (context, state) {
            if (state.halaqat.isEmpty) {
              return const SingleChildScrollView(
                child: EmptyState(
                  icon: Icons.school_outlined,
                  title: TeacherCopy.empty,
                  message: TeacherCopy.emptyMessage,
                ),
              );
            }
            return RefreshIndicator(
              onRefresh: () =>
                  ref.read(teacherAssignmentsProvider.notifier).refresh(),
              child: ListView.builder(
                padding: const EdgeInsets.only(
                  top: Insets.md,
                  bottom: Insets.giant,
                ),
                itemCount: state.halaqat.length + 1,
                itemBuilder: (context, index) {
                  if (index == 0) {
                    return _Header(demo: demo, truncated: state.truncated);
                  }
                  return ResponsiveBody(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: Insets.sm),
                      child: _AssignmentCard(
                        teaching: state.halaqat[index - 1],
                      ),
                    ),
                  );
                },
              ),
            );
          },
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.demo, required this.truncated});

  final bool demo;
  final bool truncated;

  @override
  Widget build(BuildContext context) {
    if (!demo && !truncated) return const SizedBox.shrink();
    return ResponsiveBody(
      child: Padding(
        padding: const EdgeInsets.only(bottom: Insets.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (demo) const MockBanner(message: TeacherCopy.demoBanner),
            if (truncated)
              Padding(
                padding: const EdgeInsets.only(top: Insets.sm),
                child: Text(
                  TeacherCopy.truncatedNote,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AssignmentCard extends StatelessWidget {
  const _AssignmentCard({required this.teaching});

  final MyTeaching teaching;

  @override
  Widget build(BuildContext context) {
    final placement = teaching.placement;
    return AppCard(
      onTap: () => context.push(
        Routes.teacherHalaqaRoster(teaching.assignment.halaqaId),
        extra: placement.halaqa.name,
      ),
      semanticLabel: placement.halaqa.name,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.menu_book_outlined, color: context.colors.primary),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(placement.halaqa.name, style: context.text.titleSmall),
                const SizedBox(height: 2),
                Text(
                  '${placement.section.name} · ${placement.program.name}',
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  TeacherCopy.role(teaching.assignment.role),
                  style: context.text.bodySmall,
                ),
              ],
            ),
          ),
          Icon(
            Icons.chevron_right_rounded,
            color: context.colors.onSurfaceVariant,
          ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Insets.xxl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.cloud_off_rounded,
            size: 40,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(height: Insets.md),
          Text(
            message,
            textAlign: TextAlign.center,
            style: context.text.titleMedium,
          ),
          const SizedBox(height: Insets.md),
          OutlinedButton(
            onPressed: onRetry,
            child: const Text(TeacherCopy.refresh),
          ),
        ],
      ),
    );
  }
}
