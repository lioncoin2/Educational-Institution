import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/scheduling.dart';
import '../../providers/app_providers.dart';
import '../auth/sign_in_prompt.dart';
import 'scheduling_copy.dart';
import 'state/scheduling_controller.dart';
import 'widgets/lesson_form_sheet.dart';

/// One lesson: its captured wall clock, timezone and status, with edit and
/// cancel for an authorised owner/admin while it is SCHEDULED.
class SchedulingDetailScreen extends ConsumerWidget {
  const SchedulingDetailScreen({super.key, required this.lessonId});

  final String lessonId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canManage = ref.watch(
      sessionUserProvider.select(
        (session) => session.value?.can('operations.schedule_manage') ?? false,
      ),
    );
    final lesson = ref.watch(schedulingLessonProvider(lessonId));
    return Scaffold(
      appBar: AppBar(title: Text(lesson.value?.title ?? SchedulingCopy.title)),
      body: SafeArea(
        child: AsyncView<ScheduledLesson>(
          value: lesson,
          onRetry: () => ref.invalidate(schedulingLessonProvider(lessonId)),
          errorBuilder: (context, error) => SignInPrompt.forError(
            error,
            onReturn: () => ref.invalidate(schedulingLessonProvider(lessonId)),
          ),
          builder: (context, value) => _LessonDetail(lesson: value, canManage: canManage),
        ),
      ),
    );
  }
}

class _LessonDetail extends ConsumerWidget {
  const _LessonDetail({required this.lesson, required this.canManage});

  final ScheduledLesson lesson;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final modifiable = lesson.status.isScheduled;
    return ResponsiveBody(
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: Insets.md),
        children: [
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _row(context, SchedulingCopy.date, lesson.localDate),
                const SizedBox(height: Insets.sm),
                _row(context, SchedulingCopy.time, lesson.localTime),
                const SizedBox(height: Insets.sm),
                _row(context, SchedulingCopy.timezone, lesson.timezone),
                const SizedBox(height: Insets.sm),
                _row(context, 'الحالة', SchedulingCopy.status(lesson.status)),
              ],
            ),
          ),
          if (canManage && modifiable) ...[
            const SizedBox(height: Insets.lg),
            FilledButton.tonalIcon(
              key: const Key('scheduling-edit'),
              onPressed: () => _edit(context, ref),
              icon: const Icon(Icons.edit_outlined),
              label: const Text(SchedulingCopy.editLesson),
            ),
            const SizedBox(height: Insets.sm),
            OutlinedButton.icon(
              key: const Key('scheduling-cancel'),
              onPressed: () => _cancel(context, ref),
              icon: const Icon(Icons.event_busy_outlined),
              label: const Text(SchedulingCopy.cancelLesson),
            ),
          ],
        ],
      ),
    );
  }

  Widget _row(BuildContext context, String label, String value) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(label, style: context.text.bodyMedium?.copyWith(color: context.colors.outline)),
        ),
        const SizedBox(width: Insets.md),
        Expanded(
          child: Text(value, textAlign: TextAlign.end, style: context.text.bodyMedium),
        ),
      ],
    );
  }

  Future<void> _edit(BuildContext context, WidgetRef ref) {
    return showLessonForm(
      context,
      spec: LessonFormSpec(
        title: SchedulingCopy.editLesson,
        submitLabel: SchedulingCopy.save,
        successMessage: SchedulingCopy.updated,
        chooseHalaqa: false,
        initialTitle: lesson.title,
        initialDate: lesson.localDate,
        initialTime: lesson.localTime,
        initialTimezone: lesson.timezone,
        onSubmit: (values) => ref.read(schedulingListProvider.notifier).reschedule(
              lesson.id,
              date: values.date,
              time: values.time,
              timezone: values.timezone,
              title: values.title,
            ),
      ),
    );
  }

  Future<void> _cancel(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(SchedulingCopy.cancelQuestion('${lesson.localDate} ${lesson.localTime}')),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text(SchedulingCopy.keep),
          ),
          FilledButton(
            key: const Key('scheduling-cancel-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text(SchedulingCopy.confirmCancel),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ref.read(schedulingListProvider.notifier).cancel(lesson.id);
    } on SchedulingException catch (error) {
      messenger.toast(SchedulingCopy.changeFailed(error.code));
      return;
    }
    messenger.toast(SchedulingCopy.cancelledToast);
  }
}
