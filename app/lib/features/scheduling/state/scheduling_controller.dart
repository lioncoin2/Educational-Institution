import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/scheduling.dart';
import '../../../providers/app_providers.dart';

/// The scheduled-lessons list. Holds the accumulated page and its cursor; a
/// mutation re-reads from the server (nothing is mutated optimistically, so a
/// refusal simply leaves the last good data in place and the caller surfaces
/// the typed error).
class SchedulingListController extends AsyncNotifier<LessonPage> {
  @override
  Future<LessonPage> build() => ref.watch(schedulingRepositoryProvider).lessons();

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || current.nextCursor == null) return;
    final next =
        await ref.read(schedulingRepositoryProvider).lessons(cursor: current.nextCursor);
    state = AsyncData(
      LessonPage(items: [...current.items, ...next.items], nextCursor: next.nextCursor),
    );
  }

  Future<ScheduledLesson> schedule({
    required String halaqaId,
    String? title,
    required String date,
    required String time,
    required String timezone,
    String? clientRequestId,
  }) async {
    final lesson = await ref.read(schedulingRepositoryProvider).schedule(
          halaqaId: halaqaId,
          title: title,
          date: date,
          time: time,
          timezone: timezone,
          clientRequestId: clientRequestId,
        );
    ref.invalidateSelf();
    return lesson;
  }

  Future<ScheduledLesson> reschedule(
    String id, {
    required String date,
    required String time,
    required String timezone,
    String? title,
  }) async {
    final lesson = await ref.read(schedulingRepositoryProvider).reschedule(
          id,
          date: date,
          time: time,
          timezone: timezone,
          title: title,
        );
    ref.invalidateSelf();
    ref.invalidate(schedulingLessonProvider(id));
    return lesson;
  }

  Future<ScheduledLesson> cancel(String id) async {
    final lesson = await ref.read(schedulingRepositoryProvider).cancel(id);
    ref.invalidateSelf();
    ref.invalidate(schedulingLessonProvider(id));
    return lesson;
  }
}

final schedulingListProvider =
    AsyncNotifierProvider.autoDispose<SchedulingListController, LessonPage>(
      SchedulingListController.new,
      retry: (_, _) => null,
    );

/// One lesson, by id — for the detail screen. Re-read after a mutation.
final schedulingLessonProvider = FutureProvider.autoDispose.family<ScheduledLesson, String>(
  (ref, id) => ref.watch(schedulingRepositoryProvider).lesson(id),
  retry: (_, _) => null,
);
