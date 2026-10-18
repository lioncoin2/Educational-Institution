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
import '../academic_admin/academic_history_copy.dart';
import '../academic_admin/academic_people_copy.dart';
import '../auth/sign_in_prompt.dart';
import 'state/teacher_history_controller.dart';
import 'teacher_copy.dart';

/// سجلّ إسناداتي — the signed-in teacher's own assignment record: every status,
/// newest first, each halaqa with where it sits, the teaching role and the
/// dates (`GET /academic/me/teaching`, `academic.read`). Read-only; the server
/// answers by the authenticated identity, so a teacher sees only their own
/// record and no roster here. Loading, empty, error and load-more are handled;
/// it holds no business logic, calling [TeacherHistoryController] only.
class TeacherHistoryScreen extends ConsumerWidget {
  const TeacherHistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final record = ref.watch(teacherHistoryProvider);
    final demo = !ref.watch(backendModeProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(TeacherCopy.historyTitle),
        actions: [
          IconButton(
            tooltip: AcademicHistoryCopy.refresh,
            onPressed: () => ref.invalidate(teacherHistoryProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: record,
          onRetry: () => ref.invalidate(teacherHistoryProvider),
          errorBuilder: (context, error) =>
              SignInPrompt.forError(
                error,
                onReturn: () => ref.invalidate(teacherHistoryProvider),
              ) ??
              _HistoryError(
                message: AcademicHistoryCopy.historyFailed(
                  error is AcademicException ? error.code : 'unknown',
                ),
                onRetry: () => ref.invalidate(teacherHistoryProvider),
              ),
          builder: (context, state) {
            if (state.items.isEmpty) {
              return const SingleChildScrollView(
                physics: AlwaysScrollableScrollPhysics(),
                child: EmptyState(
                  icon: Icons.history_edu_outlined,
                  title: TeacherCopy.historyEmpty,
                  message: TeacherCopy.historyEmptyMessage,
                ),
              );
            }
            return RefreshIndicator(
              onRefresh: () =>
                  ref.read(teacherHistoryProvider.notifier).refresh(),
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
                                message: AcademicHistoryCopy.demoBanner,
                              ),
                            ),
                          )
                        : const SizedBox.shrink();
                  }
                  if (index == state.items.length + 1) {
                    return _Footer(
                      hasMore: state.hasMore,
                      loadingMore: state.loadingMore,
                      loadMoreFailed: state.loadMoreFailed,
                      onLoadMore: () =>
                          ref.read(teacherHistoryProvider.notifier).loadMore(),
                    );
                  }
                  return ResponsiveBody(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: Insets.sm),
                      child: _AssignmentTile(entry: state.items[index - 1]),
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

class _AssignmentTile extends StatelessWidget {
  const _AssignmentTile({required this.entry});

  final PlacedAssignment entry;

  @override
  Widget build(BuildContext context) {
    final a = entry.assignment;
    final dates = StringBuffer('${AcademicHistoryCopy.startedOn} ')
      ..write(AcademicHistoryCopy.date(a.startedAt));
    if (a.endedAt case final ended?) {
      dates.write(
        ' · ${AcademicHistoryCopy.endedOn} ${AcademicHistoryCopy.date(ended)}',
      );
    }
    return AppCard(
      semanticLabel: entry.placement.halaqa.name,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.menu_book_outlined, color: context.colors.primary),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(entry.placement.halaqa.name, style: context.text.titleSmall),
                const SizedBox(height: 2),
                Text(
                  '${entry.placement.section.name} · '
                  '${entry.placement.program.name}',
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '${TeacherCopy.role(a.role)} · ${dates.toString()}',
                  style: context.text.bodySmall,
                ),
              ],
            ),
          ),
          _StatusChip(
            active: a.isActive,
            label: AcademicPeopleCopy.assignmentStatus(a.status),
          ),
        ],
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.active, required this.label});

  final bool active;
  final String label;

  @override
  Widget build(BuildContext context) {
    final color =
        active ? context.colors.primary : context.colors.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.sm,
        vertical: Insets.xs,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(label, style: context.text.labelSmall?.copyWith(color: color)),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({
    required this.hasMore,
    required this.loadingMore,
    required this.loadMoreFailed,
    required this.onLoadMore,
  });

  final bool hasMore;
  final bool loadingMore;
  final bool loadMoreFailed;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    if (!hasMore) return const SizedBox(height: Insets.lg);
    if (loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: onLoadMore,
        child: Text(
          loadMoreFailed
              ? AcademicHistoryCopy.loadMoreFailed
              : AcademicHistoryCopy.loadMore,
        ),
      ),
    );
  }
}

class _HistoryError extends StatelessWidget {
  const _HistoryError({required this.message, required this.onRetry});

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
            child: const Text(AcademicHistoryCopy.refresh),
          ),
        ],
      ),
    );
  }
}
