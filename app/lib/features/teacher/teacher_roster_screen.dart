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
    show halaqaRosterProvider, halaqaTeachersProvider;
import '../messaging/widgets/start_direct_message_button.dart';
import 'teacher_copy.dart';

/// One of the teacher's halaqat, read-only: its current students and its
/// co-teachers. Both lists come from the shared providers
/// (`GET /academic/halaqat/:id/students` and `.../teachers`, current only,
/// keyset-paged); the server authorises per halaqa and returns only the halaqat
/// the teacher actively teaches, so a modified id yields a refusal — shown in
/// words, never an empty "success". No management controls; no directory.
class TeacherRosterScreen extends ConsumerWidget {
  const TeacherRosterScreen({
    super.key,
    required this.halaqaId,
    this.halaqaName,
  });

  final String halaqaId;

  /// Passed from the workspace card for context; null on a deep-link refresh,
  /// where a neutral title is shown instead (the roster still loads).
  final String? halaqaName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(halaqaName ?? TeacherCopy.halaqaFallbackTitle),
          actions: [
            IconButton(
              tooltip: TeacherCopy.refresh,
              onPressed: () {
                ref.invalidate(halaqaRosterProvider(halaqaId));
                ref.invalidate(halaqaTeachersProvider(halaqaId));
              },
              icon: const Icon(Icons.refresh_rounded),
            ),
            const SizedBox(width: Insets.sm),
          ],
          bottom: const TabBar(
            tabs: [
              Tab(text: TeacherCopy.studentsTab),
              Tab(text: TeacherCopy.teachersTab),
            ],
          ),
        ),
        body: SafeArea(
          top: false,
          child: TabBarView(
            children: [
              _StudentsTab(halaqaId: halaqaId),
              _TeachersTab(halaqaId: halaqaId),
            ],
          ),
        ),
      ),
    );
  }
}

class _StudentsTab extends ConsumerWidget {
  const _StudentsTab({required this.halaqaId});

  final String halaqaId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roster = ref.watch(halaqaRosterProvider(halaqaId));
    final demo = !ref.watch(backendModeProvider);
    // A teacher may start a direct conversation with a student (staff hold
    // `messaging.start_direct`). The server re-authorises every start, so this
    // only governs the affordance; it grants nothing and invents no policy.
    final canMessageStudent = ref.watch(
      sessionUserProvider.select(
        (session) => session.value?.can('messaging.start_direct') ?? false,
      ),
    );
    return AsyncView(
      value: roster,
      onRetry: () => ref.invalidate(halaqaRosterProvider(halaqaId)),
      errorBuilder: (context, error) => _RosterError(
        message: TeacherCopy.rosterFailed(
          error is AcademicException ? error.code : 'unknown',
        ),
        onRetry: () => ref.invalidate(halaqaRosterProvider(halaqaId)),
      ),
      builder: (context, state) => _PagedList(
        demo: demo,
        itemCount: state.items.length,
        hasMore: state.hasMore,
        loadingMore: state.loadingMore,
        loadMoreFailed: state.loadMoreFailed,
        emptyIcon: Icons.groups_outlined,
        emptyTitle: TeacherCopy.noStudents,
        emptyMessage: TeacherCopy.noStudentsMessage,
        onRefresh: () =>
            ref.read(halaqaRosterProvider(halaqaId).notifier).refresh(),
        onLoadMore: () =>
            ref.read(halaqaRosterProvider(halaqaId).notifier).loadMore(),
        itemBuilder: (i) {
          final person = state.items[i].student;
          return _PersonCard(
            name: person.displayName,
            active: person.active,
            subtitle: null,
            icon: Icons.person_outline,
            // Contact a current, active student; a suspended account is not
            // offered the action (the server would refuse an unreachable one).
            trailing: canMessageStudent && person.active
                ? StartDirectMessageButton(
                    key: Key('message-student-${person.userId}'),
                    userId: person.userId,
                    label: TeacherCopy.messageStudent,
                  )
                : null,
          );
        },
      ),
    );
  }
}

class _TeachersTab extends ConsumerWidget {
  const _TeachersTab({required this.halaqaId});

  final String halaqaId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final teachers = ref.watch(halaqaTeachersProvider(halaqaId));
    final demo = !ref.watch(backendModeProvider);
    return AsyncView(
      value: teachers,
      onRetry: () => ref.invalidate(halaqaTeachersProvider(halaqaId)),
      errorBuilder: (context, error) => _RosterError(
        message: TeacherCopy.rosterFailed(
          error is AcademicException ? error.code : 'unknown',
        ),
        onRetry: () => ref.invalidate(halaqaTeachersProvider(halaqaId)),
      ),
      builder: (context, state) => _PagedList(
        demo: demo,
        itemCount: state.items.length,
        hasMore: state.hasMore,
        loadingMore: state.loadingMore,
        loadMoreFailed: state.loadMoreFailed,
        emptyIcon: Icons.school_outlined,
        emptyTitle: TeacherCopy.noTeachers,
        emptyMessage: TeacherCopy.noTeachersMessage,
        onRefresh: () =>
            ref.read(halaqaTeachersProvider(halaqaId).notifier).refresh(),
        onLoadMore: () =>
            ref.read(halaqaTeachersProvider(halaqaId).notifier).loadMore(),
        itemBuilder: (i) {
          final entry = state.items[i];
          return _PersonCard(
            name: entry.teacher.displayName,
            active: entry.teacher.active,
            subtitle: TeacherCopy.role(entry.assignment.role),
            icon: Icons.school_outlined,
          );
        },
      ),
    );
  }
}

/// A keyset-paged read-only list: an optional demo banner, the rows, then a
/// load-more footer — or a genuine empty state (never confused with an error).
class _PagedList extends StatelessWidget {
  const _PagedList({
    required this.demo,
    required this.itemCount,
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
  final int itemCount;
  final bool hasMore;
  final bool loadingMore;
  final bool loadMoreFailed;
  final IconData emptyIcon;
  final String emptyTitle;
  final String emptyMessage;
  final Future<void> Function() onRefresh;
  final VoidCallback onLoadMore;
  final Widget Function(int index) itemBuilder;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.builder(
        padding: const EdgeInsets.only(top: Insets.md, bottom: Insets.giant),
        itemCount: itemCount + 2,
        itemBuilder: (context, index) {
          if (index == 0) {
            return demo
                ? const ResponsiveBody(
                    child: Padding(
                      padding: EdgeInsets.only(bottom: Insets.sm),
                      child: MockBanner(message: TeacherCopy.demoBanner),
                    ),
                  )
                : const SizedBox.shrink();
          }
          if (index == itemCount + 1) {
            if (itemCount == 0) {
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
                      ? TeacherCopy.loadMoreFailed
                      : TeacherCopy.loadMore,
                ),
              ),
            );
          }
          return ResponsiveBody(
            child: Padding(
              padding: const EdgeInsets.only(bottom: Insets.sm),
              child: itemBuilder(index - 1),
            ),
          );
        },
      ),
    );
  }
}

class _PersonCard extends StatelessWidget {
  const _PersonCard({
    required this.name,
    required this.active,
    required this.subtitle,
    required this.icon,
    this.trailing,
  });

  final String? name;
  final bool active;
  final String? subtitle;
  final IconData icon;

  /// An optional end-of-row action (e.g. message this student). Null = none.
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final lines = <String>[?subtitle, if (!active) TeacherCopy.inactiveAccount];
    return AppCard(
      child: Row(
        children: [
          Icon(icon, color: context.colors.onSurfaceVariant),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name ?? TeacherCopy.unnamed,
                  style: context.text.titleSmall,
                ),
                if (lines.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    lines.join(' · '),
                    style: context.text.bodySmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
          ?trailing,
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
