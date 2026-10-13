import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/academic.dart';
import '../../../providers/app_providers.dart';

/// The current (ACTIVE) student roster and teaching list of one halaqa, for a
/// holder of `academic.manage` (OWNER/ADMIN). Reads a keyset page at a time;
/// mutations (enrol / assign / end) call the server — which re-authorises and
/// confirms eligibility — and then re-read. A refusal throws [AcademicException]
/// and changes nothing. Ending preserves history: an ended record leaves the
/// ACTIVE list, never the server.
const _activeOnly = 'ACTIVE';

class RosterState {
  const RosterState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  final List<HalaqaRosterEntry> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  RosterState copyWith({bool? loadingMore, bool? loadMoreFailed}) =>
      RosterState(
        items: items,
        nextCursor: nextCursor,
        loadingMore: loadingMore ?? this.loadingMore,
        loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
      );
}

class HalaqaRosterController extends AsyncNotifier<RosterState> {
  HalaqaRosterController(this.halaqaId);

  final String halaqaId;

  @override
  Future<RosterState> build() async {
    ref.watch(academicRepositoryProvider);
    final page = await ref
        .read(academicRepositoryProvider)
        .halaqaStudents(halaqaId, status: _activeOnly);
    return RosterState(items: page.items, nextCursor: page.nextCursor);
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
          .halaqaStudents(
            halaqaId,
            status: _activeOnly,
            cursor: current.nextCursor,
          );
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final e in now.items) e.enrollment.id};
      state = AsyncData(
        RosterState(
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

  Future<void> enroll(String studentUserId) async {
    await ref
        .read(academicRepositoryProvider)
        .enrollStudent(halaqaId, studentUserId: studentUserId);
    ref.invalidateSelf();
  }

  Future<void> endEnrollment(
    String enrollmentId, {
    required EnrollmentOutcome outcome,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .endEnrollment(enrollmentId, outcome: outcome);
    ref.invalidateSelf();
  }
}

final halaqaRosterProvider = AsyncNotifierProvider.autoDispose
    .family<HalaqaRosterController, RosterState, String>(
      HalaqaRosterController.new,
      retry: (_, _) => null,
    );

class TeachersState {
  const TeachersState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  final List<HalaqaTeacherEntry> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  TeachersState copyWith({bool? loadingMore, bool? loadMoreFailed}) =>
      TeachersState(
        items: items,
        nextCursor: nextCursor,
        loadingMore: loadingMore ?? this.loadingMore,
        loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
      );
}

class HalaqaTeachersController extends AsyncNotifier<TeachersState> {
  HalaqaTeachersController(this.halaqaId);

  final String halaqaId;

  @override
  Future<TeachersState> build() async {
    ref.watch(academicRepositoryProvider);
    final page = await ref
        .read(academicRepositoryProvider)
        .halaqaTeachers(halaqaId, status: _activeOnly);
    return TeachersState(items: page.items, nextCursor: page.nextCursor);
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
          .halaqaTeachers(
            halaqaId,
            status: _activeOnly,
            cursor: current.nextCursor,
          );
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final e in now.items) e.assignment.id};
      state = AsyncData(
        TeachersState(
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

  Future<void> assign(
    String teacherUserId, {
    required TeachingRole role,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .assignTeacher(halaqaId, teacherUserId: teacherUserId, role: role);
    ref.invalidateSelf();
  }

  Future<void> endAssignment(String assignmentId) async {
    await ref.read(academicRepositoryProvider).endAssignment(assignmentId);
    ref.invalidateSelf();
  }
}

final halaqaTeachersProvider = AsyncNotifierProvider.autoDispose
    .family<HalaqaTeachersController, TeachersState, String>(
      HalaqaTeachersController.new,
      retry: (_, _) => null,
    );
