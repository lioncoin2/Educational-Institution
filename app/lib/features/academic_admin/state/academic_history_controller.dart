import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/academic.dart';
import '../../../providers/app_providers.dart';

/// Read-only academic relationship history for a holder of `academic.manage`
/// (OWNER/ADMIN): one person's enrolments or assignments, newest first, every
/// status, a keyset page at a time. The server re-authorises every read; a
/// refused read surfaces as an error state, never fabricated data. No record is
/// ever created, edited or merged here — distinct rows (even for the same
/// halaqa) stay distinct, keyed by their own id.

class EnrollmentHistoryState {
  const EnrollmentHistoryState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  final List<PlacedEnrollment> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  EnrollmentHistoryState copyWith({bool? loadingMore, bool? loadMoreFailed}) =>
      EnrollmentHistoryState(
        items: items,
        nextCursor: nextCursor,
        loadingMore: loadingMore ?? this.loadingMore,
        loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
      );
}

class StudentEnrollmentsController
    extends AsyncNotifier<EnrollmentHistoryState> {
  StudentEnrollmentsController(this.userId);

  final String userId;

  @override
  Future<EnrollmentHistoryState> build() async {
    ref.watch(academicRepositoryProvider);
    final page = await ref
        .read(academicRepositoryProvider)
        .studentEnrollments(userId);
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
          .studentEnrollments(userId, cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final e in now.items) e.enrollment.id};
      state = AsyncData(
        EnrollmentHistoryState(
          items: [
            ...now.items,
            for (final e in page.items)
              if (!seen.contains(e.enrollment.id)) e,
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

final studentEnrollmentsProvider = AsyncNotifierProvider.autoDispose
    .family<StudentEnrollmentsController, EnrollmentHistoryState, String>(
      StudentEnrollmentsController.new,
      retry: (_, _) => null,
    );

class AssignmentHistoryState {
  const AssignmentHistoryState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  final List<PlacedAssignment> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  AssignmentHistoryState copyWith({bool? loadingMore, bool? loadMoreFailed}) =>
      AssignmentHistoryState(
        items: items,
        nextCursor: nextCursor,
        loadingMore: loadingMore ?? this.loadingMore,
        loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
      );
}

class TeacherAssignmentsController
    extends AsyncNotifier<AssignmentHistoryState> {
  TeacherAssignmentsController(this.userId);

  final String userId;

  @override
  Future<AssignmentHistoryState> build() async {
    ref.watch(academicRepositoryProvider);
    final page = await ref
        .read(academicRepositoryProvider)
        .teacherAssignments(userId);
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
          .teacherAssignments(userId, cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final e in now.items) e.assignment.id};
      state = AsyncData(
        AssignmentHistoryState(
          items: [
            ...now.items,
            for (final e in page.items)
              if (!seen.contains(e.assignment.id)) e,
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

final teacherAssignmentsProvider = AsyncNotifierProvider.autoDispose
    .family<TeacherAssignmentsController, AssignmentHistoryState, String>(
      TeacherAssignmentsController.new,
      retry: (_, _) => null,
    );
