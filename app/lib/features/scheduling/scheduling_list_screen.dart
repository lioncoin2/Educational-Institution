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
import '../../data/models/scheduling.dart';
import '../../providers/app_providers.dart';
import '../auth/sign_in_prompt.dart';
import 'scheduling_copy.dart';
import 'state/scheduling_controller.dart';
import 'widgets/lesson_form_sheet.dart';

/// Lists scheduled lessons and lets an authorised owner/admin add one. The
/// server authorises every call; the add control is a courtesy gate.
class SchedulingListScreen extends ConsumerWidget {
  const SchedulingListScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canManage = ref.watch(
      sessionUserProvider.select(
        (session) => session.value?.can('operations.schedule_manage') ?? false,
      ),
    );
    return Scaffold(
      appBar: AppBar(
        title: const Text(SchedulingCopy.title),
        actions: [
          IconButton(
            tooltip: SchedulingCopy.refresh,
            onPressed: () => ref.invalidate(schedulingListProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              key: const Key('scheduling-add-fab'),
              onPressed: () => _create(context, ref),
              icon: const Icon(Icons.add),
              label: const Text(SchedulingCopy.addLesson),
            )
          : null,
      body: SafeArea(top: false, child: _LessonList()),
    );
  }
}

Future<void> _create(BuildContext context, WidgetRef ref) {
  return showLessonForm(
    context,
    spec: LessonFormSpec(
      title: SchedulingCopy.addLesson,
      submitLabel: SchedulingCopy.create,
      successMessage: SchedulingCopy.created,
      chooseHalaqa: true,
      onSubmit: (values) => ref.read(schedulingListProvider.notifier).schedule(
            halaqaId: values.halaqaId!,
            title: values.title,
            date: values.date,
            time: values.time,
            timezone: values.timezone,
            clientRequestId: values.clientRequestId,
          ),
    ),
  );
}

class _LessonList extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final page = ref.watch(schedulingListProvider);
    final demo = !ref.watch(backendModeProvider);
    return AsyncView<LessonPage>(
      value: page,
      onRetry: () => ref.invalidate(schedulingListProvider),
      errorBuilder: (context, error) =>
          SignInPrompt.forError(error, onReturn: () => ref.invalidate(schedulingListProvider)),
      builder: (context, value) {
        if (value.items.isEmpty) {
          return const SingleChildScrollView(
            child: ResponsiveBody(
              child: EmptyState(
                icon: Icons.event_outlined,
                title: SchedulingCopy.empty,
                message: SchedulingCopy.emptyMessage,
              ),
            ),
          );
        }
        final rows = value.items;
        return RefreshIndicator(
          onRefresh: () => ref.read(schedulingListProvider.notifier).refresh(),
          child: ListView.builder(
            itemCount: rows.length + 1 + (value.nextCursor != null ? 1 : 0),
            itemBuilder: (context, index) {
              if (index == 0) {
                return demo
                    ? const ResponsiveBody(
                        child: Padding(
                          padding: EdgeInsets.only(bottom: Insets.sm),
                          child: MockBanner(message: 'بيانات تجريبية'),
                        ),
                      )
                    : const SizedBox.shrink();
              }
              final rowIndex = index - 1;
              if (rowIndex < rows.length) {
                return ResponsiveBody(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: Insets.sm),
                    child: _LessonCard(lesson: rows[rowIndex]),
                  ),
                );
              }
              // The load-more row.
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: Insets.sm),
                  child: OutlinedButton(
                    key: const Key('scheduling-load-more'),
                    onPressed: () => ref.read(schedulingListProvider.notifier).loadMore(),
                    child: const Text(SchedulingCopy.loadMore),
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

class _LessonCard extends StatelessWidget {
  const _LessonCard({required this.lesson});

  final ScheduledLesson lesson;

  @override
  Widget build(BuildContext context) {
    final cancelled = lesson.status.isCancelled;
    return AppCard(
      onTap: () => context.push(Routes.schedulingLesson(lesson.id)),
      child: ListTile(
        key: Key('scheduling-lesson-${lesson.id}'),
        contentPadding: EdgeInsets.zero,
        title: Text(
          lesson.title ?? SchedulingCopy.subtitle,
          style: context.text.titleSmall?.copyWith(
            decoration: cancelled ? TextDecoration.lineThrough : null,
          ),
        ),
        subtitle: Text('${lesson.localDate} · ${lesson.localTime} (${lesson.timezone})'),
        trailing: _StatusChip(status: lesson.status),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final LessonStatus status;

  @override
  Widget build(BuildContext context) {
    final cancelled = status.isCancelled;
    final color = cancelled ? context.colors.error : context.colors.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Insets.sm, vertical: 2),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: Radii.pill),
      child: Text(SchedulingCopy.status(status), style: context.text.labelSmall?.copyWith(color: color)),
    );
  }
}
