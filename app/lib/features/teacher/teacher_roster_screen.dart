import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/academic.dart';
import '../../providers/app_providers.dart';
import '../academic_admin/state/halaqa_people_controller.dart'
    show halaqaRosterProvider;
import 'teacher_copy.dart';

/// Read-only student roster of one of the teacher's halaqat. The data comes
/// from the shared [halaqaRosterProvider] (`GET /academic/halaqat/:id/students`,
/// current students only); the server authorises per halaqa and returns only
/// the halaqat the teacher actively teaches — a modified id simply yields a
/// refusal here. No management controls, no institution-wide search.
class TeacherRosterScreen extends ConsumerWidget {
  const TeacherRosterScreen({super.key, required this.halaqaId});

  final String halaqaId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roster = ref.watch(halaqaRosterProvider(halaqaId));
    final demo = !ref.watch(backendModeProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(TeacherCopy.rosterTitle),
        actions: [
          IconButton(
            tooltip: TeacherCopy.refresh,
            onPressed: () => ref.invalidate(halaqaRosterProvider(halaqaId)),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: roster,
          onRetry: () => ref.invalidate(halaqaRosterProvider(halaqaId)),
          errorBuilder: (context, error) => _RosterError(
            message: TeacherCopy.rosterFailed(
              error is AcademicException ? error.code : 'unknown',
            ),
            onRetry: () => ref.invalidate(halaqaRosterProvider(halaqaId)),
          ),
          builder: (context, state) {
            return RefreshIndicator(
              onRefresh: () =>
                  ref.read(halaqaRosterProvider(halaqaId).notifier).refresh(),
              child: ListView.builder(
                padding: const EdgeInsets.only(
                  top: Insets.md,
                  bottom: Insets.giant,
                ),
                itemCount: state.items.length + 2,
                itemBuilder: (context, index) {
                  if (index == 0) {
                    return demo
                        ? const ResponsiveBody(
                            child: Padding(
                              padding: EdgeInsets.only(bottom: Insets.sm),
                              child: MockBanner(
                                message: TeacherCopy.demoBanner,
                              ),
                            ),
                          )
                        : const SizedBox.shrink();
                  }
                  if (index == state.items.length + 1) {
                    if (state.items.isEmpty) {
                      return const Padding(
                        padding: EdgeInsets.only(top: Insets.xl),
                        child: EmptyState(
                          icon: Icons.groups_outlined,
                          title: TeacherCopy.noStudents,
                          message: TeacherCopy.noStudentsMessage,
                        ),
                      );
                    }
                    if (!state.hasMore) {
                      return const SizedBox(height: Insets.lg);
                    }
                    if (state.loadingMore) {
                      return const Padding(
                        padding: EdgeInsets.all(Insets.lg),
                        child: Center(
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      );
                    }
                    return Center(
                      child: TextButton(
                        onPressed: () => ref
                            .read(halaqaRosterProvider(halaqaId).notifier)
                            .loadMore(),
                        child: Text(
                          state.loadMoreFailed
                              ? TeacherCopy.loadMoreFailed
                              : TeacherCopy.loadMore,
                        ),
                      ),
                    );
                  }
                  return ResponsiveBody(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: Insets.sm),
                      child: _StudentCard(
                        student: state.items[index - 1].student,
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

class _StudentCard extends StatelessWidget {
  const _StudentCard({required this.student});

  final AcademicPerson student;

  @override
  Widget build(BuildContext context) {
    final subtitle = student.active ? null : TeacherCopy.inactiveAccount;
    return AppCard(
      child: Row(
        children: [
          Icon(Icons.person_outline, color: context.colors.onSurfaceVariant),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  student.displayName ?? TeacherCopy.unnamed,
                  style: context.text.titleSmall,
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: context.text.bodySmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RosterError extends StatelessWidget {
  const _RosterError({required this.message, required this.onRetry});

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
            Icons.lock_outline,
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
