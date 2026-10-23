import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/academic.dart';
import '../../../providers/app_providers.dart';

/// The institution's academic structure — every section with its programs, in
/// the server's order — for a holder of `academic.manage`. The reads are the
/// public catalogue (`GET /academic/sections`, active and inactive alike); the
/// writes provision the structure (create / edit / activate / deactivate). The
/// server re-authorises and validates each write; this never recomputes who may
/// act. A write that is refused throws [AcademicException] and changes nothing;
/// a write that succeeds re-reads so the tree shows the new state.
class AcademicStructureController extends AsyncNotifier<List<AcademicSection>> {
  @override
  Future<List<AcademicSection>> build() =>
      ref.watch(academicRepositoryProvider).catalogue();

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  // ── Sections ──
  Future<void> createSection({
    required String code,
    required String name,
    required int order,
    required SectionKind kind,
    String? description,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .createSection(
          code: code,
          name: name,
          order: order,
          kind: kind,
          description: description,
        );
    ref.invalidateSelf();
  }

  Future<void> updateSection(
    String sectionId, {
    required String name,
    required int order,
    String? description,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .updateSection(
          sectionId,
          name: name,
          order: order,
          description: description,
        );
    ref.invalidateSelf();
  }

  Future<void> setSectionActive(
    String sectionId, {
    required bool active,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .setSectionActive(sectionId, active: active);
    ref.invalidateSelf();
  }

  // ── Programs ──
  Future<void> createProgram({
    required String sectionId,
    required String code,
    required String name,
    required int order,
    String? description,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .createProgram(
          sectionId: sectionId,
          code: code,
          name: name,
          order: order,
          description: description,
        );
    ref.invalidateSelf();
  }

  Future<void> updateProgram(
    String programId, {
    required String name,
    required int order,
    String? description,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .updateProgram(
          programId,
          name: name,
          order: order,
          description: description,
        );
    ref.invalidateSelf();
  }

  Future<void> setProgramActive(
    String programId, {
    required bool active,
  }) async {
    await ref
        .read(academicRepositoryProvider)
        .setProgramActive(programId, active: active);
    ref.invalidateSelf();
  }

  /// Binds [coverFileAssetId] (an uploaded image) as the program's cover, or —
  /// when it is null — clears it (ADR 0038). `academic.manage` only; the server
  /// re-authorises and verifies the image. A success re-reads the tree and
  /// refreshes the program's cover link so the new image shows at once.
  Future<void> setProgramCover(String programId, String? coverFileAssetId) async {
    final repo = ref.read(academicRepositoryProvider);
    if (coverFileAssetId == null) {
      await repo.clearProgramCover(programId);
    } else {
      await repo.setProgramCover(programId, coverFileAssetId);
    }
    ref.invalidate(programCoverUrlProvider(programId));
    ref.invalidateSelf();
  }
}

final academicStructureProvider =
    AsyncNotifierProvider.autoDispose<
      AcademicStructureController,
      List<AcademicSection>
    >(
      AcademicStructureController.new,
      // A failure surfaces at once with a retry; no silent backoff.
      retry: (_, _) => null,
    );

/// A short-lived signed link to a program's cover image (ADR 0038), resolved
/// through the existing authorized route. A program without a cover, or one
/// whose link fails, resolves to null — the caller shows a fallback, never a
/// gap. Fetch it only for a program whose `coverFileAssetId` is set, so a
/// cover-less program makes no request.
final programCoverUrlProvider = FutureProvider.autoDispose.family<Uri?, String>((
  ref,
  programId,
) async {
  try {
    return await ref.read(academicRepositoryProvider).programCoverUrl(programId);
  } on AcademicException {
    return null; // no cover → fallback
  }
}, retry: (_, _) => null);
