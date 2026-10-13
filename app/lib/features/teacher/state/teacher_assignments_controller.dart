import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/academic.dart';
import '../../../providers/app_providers.dart';

/// The signed-in teacher's own current halaqat, from `GET /academic/me`
/// (`academic.read`). The server answers by the authenticated identity — there
/// is no teacher-id parameter — so no one reads another teacher's assignments.
/// Only ACTIVE assignments are shown (an ended/revoked one is not current);
/// [truncated] is the server's own flag that more relationships exist than it
/// lists at once. A failed read is an error state, never fabricated data.
class TeacherWorkspaceState {
  const TeacherWorkspaceState({required this.halaqat, this.truncated = false});

  final List<MyTeaching> halaqat;
  final bool truncated;
}

class TeacherAssignmentsController
    extends AsyncNotifier<TeacherWorkspaceState> {
  @override
  Future<TeacherWorkspaceState> build() async {
    final mine = await ref.watch(academicRepositoryProvider).me();
    return TeacherWorkspaceState(
      halaqat: mine.activeTeaching,
      truncated: mine.truncated,
    );
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }
}

final teacherAssignmentsProvider =
    AsyncNotifierProvider.autoDispose<
      TeacherAssignmentsController,
      TeacherWorkspaceState
    >(TeacherAssignmentsController.new, retry: (_, _) => null);
