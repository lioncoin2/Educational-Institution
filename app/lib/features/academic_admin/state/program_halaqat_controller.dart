import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/academic.dart';
import '../../../providers/app_providers.dart';
import 'academic_structure_controller.dart';

/// One program with its halaqat (`GET /academic/programs/:id`), for a holder of
/// `academic.manage`. The writes create a halaqa and activate / deactivate one;
/// renaming and reordering go through [updateHalaqa]. The server re-authorises
/// and validates every write, and refuses to deactivate a halaqa that still has
/// active enrolments — this never recomputes any of that. A refused write
/// throws [AcademicException] and changes nothing; a successful one re-reads the
/// program (so its halaqat and the catalogue's active-halaqa counts are fresh).
///
/// A program the server no longer has resolves to [AcademicException] with
/// `academic.program_not_found`, so the screen shows a refusal, not an empty
/// list it would read as "no halaqat yet".
class ProgramHalaqatController extends AsyncNotifier<AcademicProgramDetail> {
  ProgramHalaqatController(this.programId);

  final String programId;

  @override
  Future<AcademicProgramDetail> build() async {
    ref.watch(academicRepositoryProvider);
    return _load();
  }

  Future<AcademicProgramDetail> _load() async {
    final detail = await ref
        .read(academicRepositoryProvider)
        .program(programId);
    if (detail == null) {
      throw const AcademicException(
        'academic.program_not_found',
        'No such program.',
      );
    }
    return detail;
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  Future<void> createHalaqa({
    required String code,
    required String name,
    required int order,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .createHalaqa(
          programId: programId,
          code: code,
          name: name,
          order: order,
        );
    _reread();
  }

  Future<void> updateHalaqa(
    String halaqaId, {
    required String name,
    required int order,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .updateHalaqa(halaqaId, name: name, order: order);
    _reread();
  }

  Future<void> setHalaqaActive(String halaqaId, {required bool active}) async {
    await ref
        .read(academicRepositoryProvider)
        .setHalaqaActive(halaqaId, active: active);
    _reread();
  }

  /// Re-read this program, and the catalogue whose active-halaqa counts just
  /// changed (a no-op when the structure screen is not alive).
  void _reread() {
    ref.invalidateSelf();
    ref.invalidate(academicStructureProvider);
  }
}

final programHalaqatProvider = AsyncNotifierProvider.autoDispose
    .family<ProgramHalaqatController, AcademicProgramDetail, String>(
      ProgramHalaqatController.new,
      retry: (_, _) => null,
    );
