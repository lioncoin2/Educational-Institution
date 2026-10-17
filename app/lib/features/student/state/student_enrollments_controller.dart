import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/academic.dart';
import '../../../providers/app_providers.dart';

/// The signed-in student's own current enrollments, from `GET /academic/me`
/// (`academic.read`). The server answers by the authenticated identity — there
/// is no student-id parameter — so no one reads another student's enrollments.
/// Only ACTIVE enrollments are shown (an ended one is not current); [truncated]
/// is the server's own flag that more relationships exist than it lists at
/// once. A failed read is an error state, never fabricated data.
class StudentWorkspaceState {
  const StudentWorkspaceState({
    required this.enrollments,
    this.truncated = false,
  });

  final List<MyEnrollment> enrollments;
  final bool truncated;
}

class StudentEnrollmentsController
    extends AsyncNotifier<StudentWorkspaceState> {
  @override
  Future<StudentWorkspaceState> build() async {
    final mine = await ref.watch(academicRepositoryProvider).me();
    return StudentWorkspaceState(
      enrollments: mine.activeEnrollments,
      truncated: mine.truncated,
    );
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }
}

final studentEnrollmentsProvider =
    AsyncNotifierProvider.autoDispose<
      StudentEnrollmentsController,
      StudentWorkspaceState
    >(StudentEnrollmentsController.new, retry: (_, _) => null);
