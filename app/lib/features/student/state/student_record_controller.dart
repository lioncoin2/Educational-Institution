import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../providers/app_providers.dart';
import '../../academic_admin/state/academic_history_controller.dart'
    show EnrollmentHistoryState;

/// The SIGNED-IN student's own enrollment record (`GET /academic/me/
/// enrollments`): every status, newest first, each where it sits — a keyset
/// page at a time. The server answers by the authenticated identity (no user
/// id) and re-authorises every read; a refused read surfaces as an error state,
/// never fabricated data. Reuses [EnrollmentHistoryState] (the same paged shape
/// the admin history uses); no record is created or edited here.
class StudentRecordController extends AsyncNotifier<EnrollmentHistoryState> {
  @override
  Future<EnrollmentHistoryState> build() async {
    final page = await ref.watch(academicRepositoryProvider).myEnrollments();
    return EnrollmentHistoryState(
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
          .myEnrollments(cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final e in now.items) e.enrollment.id};
      state = AsyncData(
        EnrollmentHistoryState(
          items: [
            ...now.items,
            for (final e in page.items)
              if (seen.add(e.enrollment.id)) e,
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } catch (_) {
      final now = state.value ?? current;
      if (!ref.mounted) return;
      state = AsyncData(now.copyWith(loadingMore: false, loadMoreFailed: true));
    }
  }
}

final studentRecordProvider =
    AsyncNotifierProvider.autoDispose<
      StudentRecordController,
      EnrollmentHistoryState
    >(StudentRecordController.new, retry: (_, _) => null);
