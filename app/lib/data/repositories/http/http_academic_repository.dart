import '../../api/api_client.dart';
import '../../models/academic.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// [AcademicRepository] against the real backend (`/academic`).
///
/// Reads the catalogue, one program, one halaqa and the caller's own record;
/// and — for a holder of `academic.manage` — provisions the structure
/// (sections, programs, halaqat: create / edit / activate / deactivate). The
/// server re-authorises every write. It does NOT enrol students or assign
/// teachers (those need the unresolved people-discovery policy). Every
/// transport failure becomes an [AcademicException], keeping the server's code.
class HttpAcademicRepository implements AcademicRepository {
  HttpAcademicRepository(this._api);

  final ApiClient _api;

  @override
  DataOrigin get origin => DataOrigin.records;

  @override
  Future<List<AcademicSection>> catalogue() => _call(() async {
    final json = await _api.get('/academic/sections');
    return AcademicSection.listFromJson(json['sections']);
  });

  @override
  Future<AcademicProgramDetail?> program(String programId) => _find(
    () async => AcademicProgramDetail.fromJson(
      await _api.get('/academic/programs/${Uri.encodeComponent(programId)}'),
    ),
    notFound: 'academic.program_not_found',
  );

  @override
  Future<AcademicHalaqaDetail?> halaqa(String halaqaId) => _find(
    () async => AcademicHalaqaDetail.fromJson(
      await _api.get('/academic/halaqat/${Uri.encodeComponent(halaqaId)}'),
    ),
    notFound: 'academic.halaqa_not_found',
  );

  @override
  Future<MyAcademic> me() =>
      _call(() async => MyAcademic.fromJson(await _api.get('/academic/me')));

  // ── Structure management (academic.manage) ──
  // Bodyless POST for activate/deactivate; a `{...}` body for create/edit.
  // The server re-authorises and validates; refusals flow through [_call].

  static String _section(String id) =>
      '/academic/sections/${Uri.encodeComponent(id)}';
  static String _program(String id) =>
      '/academic/programs/${Uri.encodeComponent(id)}';
  static String _halaqa(String id) =>
      '/academic/halaqat/${Uri.encodeComponent(id)}';

  @override
  Future<AcademicSection> createSection({
    required String code,
    required String name,
    required int order,
    required SectionKind kind,
    String? description,
  }) => _call(
    () async => AcademicSection.fromJson(
      await _api.post(
        '/academic/sections',
        body: {
          'code': code,
          'name': name,
          'order': order,
          'kind': kind.wire,
          'description': ?description,
        },
      ),
    ),
  );

  @override
  Future<AcademicSection> updateSection(
    String sectionId, {
    required String name,
    required int order,
    String? description,
  }) => _call(
    () async => AcademicSection.fromJson(
      await _api.patch(
        _section(sectionId),
        body: {'name': name, 'order': order, 'description': description},
      ),
    ),
  );

  @override
  Future<AcademicSection> setSectionActive(
    String sectionId, {
    required bool active,
  }) => _call(
    () async => AcademicSection.fromJson(
      await _api.post(
        '${_section(sectionId)}/${active ? 'activate' : 'deactivate'}',
      ),
    ),
  );

  @override
  Future<AcademicProgram> createProgram({
    required String sectionId,
    required String code,
    required String name,
    required int order,
    String? description,
  }) => _call(
    () async => AcademicProgram.fromJson(
      await _api.post(
        '/academic/programs',
        body: {
          'sectionId': sectionId,
          'code': code,
          'name': name,
          'order': order,
          'description': ?description,
        },
      ),
    ),
  );

  @override
  Future<AcademicProgram> updateProgram(
    String programId, {
    required String name,
    required int order,
    String? description,
  }) => _call(
    () async => AcademicProgram.fromJson(
      await _api.patch(
        _program(programId),
        body: {'name': name, 'order': order, 'description': description},
      ),
    ),
  );

  @override
  Future<AcademicProgram> setProgramActive(
    String programId, {
    required bool active,
  }) => _call(
    () async => AcademicProgram.fromJson(
      await _api.post(
        '${_program(programId)}/${active ? 'activate' : 'deactivate'}',
      ),
    ),
  );

  @override
  Future<AcademicProgram> setProgramCover(
    String programId,
    String coverFileAssetId,
  ) => _call(
    () async => AcademicProgram.fromJson(
      await _api.put(
        '${_program(programId)}/cover',
        body: {'coverFileAssetId': coverFileAssetId},
      ),
    ),
  );

  @override
  Future<AcademicProgram> clearProgramCover(String programId) => _call(
    () async =>
        AcademicProgram.fromJson(await _api.delete('${_program(programId)}/cover')),
  );

  @override
  Future<Uri> programCoverUrl(String programId) => _call(
    () async => _api.resolve(
      (await _api.get('${_program(programId)}/cover'))['url']! as String,
    ),
  );

  @override
  Future<AcademicHalaqa> createHalaqa({
    required String programId,
    required String code,
    required String name,
    required int order,
  }) => _call(
    () async => AcademicHalaqa.fromJson(
      await _api.post(
        '/academic/halaqat',
        body: {
          'programId': programId,
          'code': code,
          'name': name,
          'order': order,
        },
      ),
    ),
  );

  @override
  Future<AcademicHalaqa> updateHalaqa(
    String halaqaId, {
    required String name,
    required int order,
  }) => _call(
    () async => AcademicHalaqa.fromJson(
      await _api.patch(_halaqa(halaqaId), body: {'name': name, 'order': order}),
    ),
  );

  @override
  Future<AcademicHalaqa> setHalaqaActive(
    String halaqaId, {
    required bool active,
  }) => _call(
    () async => AcademicHalaqa.fromJson(
      await _api.post(
        '${_halaqa(halaqaId)}/${active ? 'activate' : 'deactivate'}',
      ),
    ),
  );

  // ── Relationships (academic.manage) ──
  // Rosters are keyset pages; enrol/assign carry only an id (and a role); the
  // server re-authorises, confirms eligibility and chooses 200/201. Refusals
  // (not-eligible, already-ended, …) flow through [_call] keeping their code.

  static String _enrollment(String id) =>
      '/academic/enrollments/${Uri.encodeComponent(id)}';
  static String _assignment(String id) =>
      '/academic/teacher-assignments/${Uri.encodeComponent(id)}';

  @override
  Future<AcademicPage<HalaqaRosterEntry>> halaqaStudents(
    String halaqaId, {
    String? status,
    String? cursor,
  }) => _call(
    () async => AcademicPage.fromJson(
      await _api.get(
        '${_halaqa(halaqaId)}/students',
        query: {'status': ?status, 'cursor': ?cursor},
      ),
      HalaqaRosterEntry.fromJson,
    ),
  );

  @override
  Future<EnrollmentRecord> enrollStudent(
    String halaqaId, {
    required String studentUserId,
  }) => _call(() async {
    final json = await _api.post(
      '${_halaqa(halaqaId)}/enrollments',
      body: {'studentUserId': studentUserId},
    );
    return EnrollmentRecord.fromJson(
      (json['enrollment']! as Map).cast<String, Object?>(),
    );
  });

  @override
  Future<EnrollmentRecord> endEnrollment(
    String enrollmentId, {
    required EnrollmentOutcome outcome,
  }) => _call(
    () async => EnrollmentRecord.fromJson(
      await _api.post(
        '${_enrollment(enrollmentId)}/end',
        body: {'outcome': outcome.wire},
      ),
    ),
  );

  @override
  Future<AcademicPage<HalaqaTeacherEntry>> halaqaTeachers(
    String halaqaId, {
    String? status,
    String? cursor,
  }) => _call(
    () async => AcademicPage.fromJson(
      await _api.get(
        '${_halaqa(halaqaId)}/teachers',
        query: {'status': ?status, 'cursor': ?cursor},
      ),
      HalaqaTeacherEntry.fromJson,
    ),
  );

  @override
  Future<AssignmentRecord> assignTeacher(
    String halaqaId, {
    required String teacherUserId,
    required TeachingRole role,
  }) => _call(
    () async => AssignmentRecord.fromJson(
      await _api.post(
        '${_halaqa(halaqaId)}/teachers',
        body: {'teacherUserId': teacherUserId, 'role': role.wire},
      ),
    ),
  );

  @override
  Future<AssignmentRecord> endAssignment(String assignmentId) => _call(
    () async => AssignmentRecord.fromJson(
      await _api.post('${_assignment(assignmentId)}/end'),
    ),
  );

  // ── Relationship history (academic.manage) — keyset-paged reads ──

  @override
  Future<AcademicPage<PlacedEnrollment>> studentEnrollments(
    String userId, {
    String? cursor,
  }) => _call(
    () async => AcademicPage.fromJson(
      await _api.get(
        '/academic/students/${Uri.encodeComponent(userId)}/enrollments',
        query: {'cursor': ?cursor},
      ),
      PlacedEnrollment.fromJson,
    ),
  );

  @override
  Future<AcademicPage<PlacedAssignment>> teacherAssignments(
    String userId, {
    String? cursor,
  }) => _call(
    () async => AcademicPage.fromJson(
      await _api.get(
        '/academic/teachers/${Uri.encodeComponent(userId)}/assignments',
        query: {'cursor': ?cursor},
      ),
      PlacedAssignment.fromJson,
    ),
  );

  @override
  Future<AcademicPage<PlacedEnrollment>> myEnrollments({String? cursor}) =>
      _call(
        () async => AcademicPage.fromJson(
          await _api.get(
            '/academic/me/enrollments',
            query: {'cursor': ?cursor},
          ),
          PlacedEnrollment.fromJson,
        ),
      );

  @override
  Future<AcademicPage<PlacedAssignment>> myTeaching({String? cursor}) => _call(
    () async => AcademicPage.fromJson(
      await _api.get('/academic/me/teaching', query: {'cursor': ?cursor}),
      PlacedAssignment.fromJson,
    ),
  );

  static const _unreadable = AcademicException(
    'academic.unreadable',
    'The server sent something this app cannot read.',
  );

  /// Maps every transport failure to [AcademicException].
  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw AcademicException(error.code, error.message);
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }

  /// A 404 carrying [notFound] — and only that code — means there is no such
  /// thing: null. Any other refusal stays a refusal.
  static Future<T?> _find<T>(
    Future<T> Function() work, {
    required String notFound,
  }) => _call<T?>(() async {
    try {
      return await work();
    } on ApiException catch (error) {
      if (error.status == 404 && error.code == notFound) return null;
      rethrow;
    }
  });
}
