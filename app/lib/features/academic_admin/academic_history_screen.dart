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
import 'academic_history_copy.dart';
import 'academic_people_copy.dart';
import 'state/academic_history_controller.dart';

/// Read-only history of one student's enrolments (`academic.manage`). Every
/// status appears, newest first; distinct records stay distinct. There are no
/// mutation controls here — history is never edited.
class StudentEnrollmentHistoryScreen extends ConsumerWidget {
  const StudentEnrollmentHistoryScreen({super.key, required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final history = ref.watch(studentEnrollmentsProvider(userId));
    final demo = !ref.watch(backendModeProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(AcademicHistoryCopy.studentTitle),
        actions: [
          IconButton(
            tooltip: AcademicHistoryCopy.refresh,
            onPressed: () => ref.invalidate(studentEnrollmentsProvider(userId)),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: history,
          onRetry: () => ref.invalidate(studentEnrollmentsProvider(userId)),
          errorBuilder: (context, error) => _HistoryError(
            message: AcademicHistoryCopy.historyFailed(
              error is AcademicException ? error.code : 'unknown',
            ),
            onRetry: () => ref.invalidate(studentEnrollmentsProvider(userId)),
          ),
          builder: (context, state) => _HistoryList(
            demo: demo,
            items: state.items,
            hasMore: state.hasMore,
            loadingMore: state.loadingMore,
            loadMoreFailed: state.loadMoreFailed,
            emptyIcon: Icons.history_edu_outlined,
            emptyTitle: AcademicHistoryCopy.noEnrollments,
            emptyMessage: AcademicHistoryCopy.noEnrollmentsMessage,
            onRefresh: () =>
                ref.read(studentEnrollmentsProvider(userId).notifier).refresh(),
            onLoadMore: () => ref
                .read(studentEnrollmentsProvider(userId).notifier)
                .loadMore(),
            itemBuilder: (entry) => _EnrollmentTile(entry: entry),
          ),
        ),
      ),
    );
  }
}

/// Read-only history of one teacher's assignments (`academic.manage`).
class TeacherAssignmentHistoryScreen extends ConsumerWidget {
  const TeacherAssignmentHistoryScreen({super.key, required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final history = ref.watch(teacherAssignmentsProvider(userId));
    final demo = !ref.watch(backendModeProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(AcademicHistoryCopy.teacherTitle),
        actions: [
          IconButton(
            tooltip: AcademicHistoryCopy.refresh,
            onPressed: () => ref.invalidate(teacherAssignmentsProvider(userId)),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: history,
          onRetry: () => ref.invalidate(teacherAssignmentsProvider(userId)),
          errorBuilder: (context, error) => _HistoryError(
            message: AcademicHistoryCopy.historyFailed(
              error is AcademicException ? error.code : 'unknown',
            ),
            onRetry: () => ref.invalidate(teacherAssignmentsProvider(userId)),
          ),
          builder: (context, state) => _HistoryList(
            demo: demo,
            items: state.items,
            hasMore: state.hasMore,
            loadingMore: state.loadingMore,
            loadMoreFailed: state.loadMoreFailed,
            emptyIcon: Icons.history_edu_outlined,
            emptyTitle: AcademicHistoryCopy.noAssignments,
            emptyMessage: AcademicHistoryCopy.noAssignmentsMessage,
            onRefresh: () =>
                ref.read(teacherAssignmentsProvider(userId).notifier).refresh(),
            onLoadMore: () => ref
                .read(teacherAssignmentsProvider(userId).notifier)
                .loadMore(),
            itemBuilder: (entry) => _AssignmentTile(entry: entry),
          ),
        ),
      ),
    );
  }
}

/// A keyset-paged history list: a demo banner, the records, then a load-more
/// footer — or a genuine empty state, told apart from a failed load.
class _HistoryList<T> extends StatelessWidget {
  const _HistoryList({
    required this.demo,
    required this.items,
    required this.hasMore,
    required this.loadingMore,
    required this.loadMoreFailed,
    required this.emptyIcon,
    required this.emptyTitle,
    required this.emptyMessage,
    required this.onRefresh,
    required this.onLoadMore,
    required this.itemBuilder,
  });

  final bool demo;
  final List<T> items;
  final bool hasMore;
  final bool loadingMore;
  final bool loadMoreFailed;
  final IconData emptyIcon;
  final String emptyTitle;
  final String emptyMessage;
  final Future<void> Function() onRefresh;
  final VoidCallback onLoadMore;
  final Widget Function(T entry) itemBuilder;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.builder(
        padding: const EdgeInsets.only(top: Insets.md, bottom: Insets.giant),
        itemCount: items.length + 2,
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
          if (index == items.length + 1) {
            if (items.isEmpty) {
              return Padding(
                padding: const EdgeInsets.only(top: Insets.xl),
                child: EmptyState(
                  icon: emptyIcon,
                  title: emptyTitle,
                  message: emptyMessage,
                ),
              );
            }
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
          return ResponsiveBody(
            child: Padding(
              padding: const EdgeInsets.only(bottom: Insets.sm),
              child: itemBuilder(items[index - 1]),
            ),
          );
        },
      ),
    );
  }
}

class _EnrollmentTile extends StatelessWidget {
  const _EnrollmentTile({required this.entry});

  final PlacedEnrollment entry;

  @override
  Widget build(BuildContext context) {
    final e = entry.enrollment;
    final dates = StringBuffer('${AcademicHistoryCopy.enrolledOn} ')
      ..write(AcademicHistoryCopy.date(e.enrolledAt));
    if (e.endedAt case final ended?) {
      dates.write(
        ' · ${AcademicHistoryCopy.endedOn} ${AcademicHistoryCopy.date(ended)}',
      );
    }
    return _RecordCard(
      title: entry.placement.halaqa.name,
      placement:
          '${entry.placement.section.name} · ${entry.placement.program.name}',
      status: AcademicPeopleCopy.enrollmentStatus(e.status),
      dates: dates.toString(),
      active: e.isActive,
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
    return _RecordCard(
      title: entry.placement.halaqa.name,
      placement:
          '${entry.placement.section.name} · ${entry.placement.program.name}',
      status:
          '${AcademicPeopleCopy.role(a.role)} · ${AcademicPeopleCopy.assignmentStatus(a.status)}',
      dates: dates.toString(),
      active: a.isActive,
    );
  }
}

class _RecordCard extends StatelessWidget {
  const _RecordCard({
    required this.title,
    required this.placement,
    required this.status,
    required this.dates,
    required this.active,
  });

  final String title;
  final String placement;
  final String status;
  final String dates;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final titleColor = active ? null : context.colors.onSurfaceVariant;
    return AppCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            active ? Icons.radio_button_checked : Icons.history_toggle_off,
            size: 20,
            color: active
                ? context.colors.primary
                : context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: context.text.titleSmall?.copyWith(color: titleColor),
                ),
                const SizedBox(height: 2),
                Text(
                  placement,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 2),
                Text('$status · $dates', style: context.text.bodySmall),
              ],
            ),
          ),
        ],
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
            child: const Text(AcademicHistoryCopy.refresh),
          ),
        ],
      ),
    );
  }
}
