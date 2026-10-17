import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/academic.dart';
import '../../../providers/app_providers.dart';
import '../../academic_admin/state/academic_history_controller.dart'
    show AssignmentHistoryState;

/// The SIGNED-IN teacher's own assignment record (`GET /academic/me/teaching`):
/// every status, newest first, each where it sits — a keyset page at a time.
/// The server answers by the authenticated identity (no user id) and
/// re-authorises every read; a refused read surfaces as an error state, never
/// fabricated data. Reuses [AssignmentHistoryState] (the same paged shape the
/// admin assignment history uses); no record is created or edited here.
class TeacherHistoryController extends AsyncNotifier<AssignmentHistoryState> {
  @override
  Future<AssignmentHistoryState> build() async {
    final page = await ref.watch(academicRepositoryProvider).myTeaching();
    return AssignmentHistoryState(
      items: page.items,
      nextCursor: page.nextCursor,
    );
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null ||
        state.isLoading ||
        !current.hasMore ||
        current.loadingMore) {
      return;
    }
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await ref
          .read(academicRepositoryProvider)
          .myTeaching(cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final e in now.items) e.assignment.id};
      state = AsyncData(
        AssignmentHistoryState(
          items: [
            ...now.items,
            for (final e in page.items)
              if (seen.add(e.assignment.id)) e,
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } on AcademicException {
      if (!ref.mounted) return;
      state = AsyncData(
        (state.value ?? current).copyWith(
          loadingMore: false,
          loadMoreFailed: true,
        ),
      );
    }
  }
}

final teacherHistoryProvider =
    AsyncNotifierProvider.autoDispose<
      TeacherHistoryController,
      AssignmentHistoryState
    >(TeacherHistoryController.new, retry: (_, _) => null);
