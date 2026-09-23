/// Academic — the institution's structure (sections, programs, halaqat) and
/// the signed-in person's own place in it, as the server keeps it
/// (backend/src/modules/academic, `/academic`).
///
/// These are wire models, not screen models: the screens keep their own
/// (`Program`, `Halaqa`, `PathStep`), filled from these by the adapters in
/// `data/repositories/academic/`.
///
/// Everything is parsed defensively. A kind, status or role this version
/// does not know is kept as `unknown` — and what is unknown is never shown as
/// open, active or current. A newer server never breaks an older app; an
/// item that cannot even be identified is skipped, never fatal to its list.
library;

/// What a section is. [unknown] is anything this version has not heard of.
enum SectionKind {
  /// The graded ladder of page 6.
  progressive('PROGRESSIVE'),

  /// التهجي، البراعم، اللغات (pages 7–9).
  special('SPECIAL'),

  /// البرامج المرافقة (page 10).
  accompanying('ACCOMPANYING'),
  unknown('UNKNOWN');

  const SectionKind(this.wire);

  final String wire;

  static SectionKind fromWire(Object? value) =>
      values.firstWhere((kind) => kind.wire == value, orElse: () => unknown);
}

/// Whether a section, program or halaqa is offered. Structure is never
/// deleted — it is deactivated, and stays readable.
enum StructureStatus {
  active('ACTIVE'),
  inactive('INACTIVE'),
  unknown('UNKNOWN');

  const StructureStatus(this.wire);

  final String wire;

  static StructureStatus fromWire(Object? value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => unknown);
}

/// An enrollment is ACTIVE until staff end it, as COMPLETED or WITHDRAWN.
enum EnrollmentStatus {
  active('ACTIVE'),
  completed('COMPLETED'),
  withdrawn('WITHDRAWN'),
  unknown('UNKNOWN');

  const EnrollmentStatus(this.wire);

  final String wire;

  static EnrollmentStatus fromWire(Object? value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => unknown);
}

/// How a teacher is assigned to a halaqa.
enum TeachingRole {
  teacher('TEACHER'),
  assistantTeacher('ASSISTANT_TEACHER'),
  unknown('UNKNOWN');

  const TeachingRole(this.wire);

  final String wire;

  static TeachingRole fromWire(Object? value) =>
      values.firstWhere((r) => r.wire == value, orElse: () => unknown);
}

enum AssignmentStatus {
  active('ACTIVE'),
  ended('ENDED'),
  unknown('UNKNOWN');

  const AssignmentStatus(this.wire);

  final String wire;

  static AssignmentStatus fromWire(Object? value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => unknown);
}

/// A program of a section, as the catalogue lists it.
class AcademicProgram {
  const AcademicProgram({
    required this.id,
    required this.code,
    required this.sectionId,
    required this.name,
    required this.order,
    required this.status,
    required this.activeHalaqaCount,
    this.description,
  });

  /// Throws [FormatException] when it cannot be identified or named.
  factory AcademicProgram.fromJson(Map<String, Object?> json) =>
      AcademicProgram(
        id: _required(json, 'id'),
        code: _required(json, 'code'),
        sectionId: _required(json, 'sectionId'),
        name: _required(json, 'name'),
        order: _int(json['order']),
        status: StructureStatus.fromWire(json['status']),
        activeHalaqaCount: _int(json['activeHalaqaCount']),
        description: _optional(json['description']),
      );

  /// The server's id — what the API is asked by.
  final String id;

  /// Stable and readable (`dep-literacy-program`, `prog-nahw`) — what the
  /// app's own routes use, in both the demo and against the server.
  final String code;
  final String sectionId;
  final String name;
  final int order;
  final StructureStatus status;

  /// ACTIVE halaqat only, counted by the server.
  final int activeHalaqaCount;
  final String? description;

  bool get isActive => status == StructureStatus.active;
}

/// A section with its programs, in the server's order (position, then code).
class AcademicSection {
  const AcademicSection({
    required this.id,
    required this.code,
    required this.name,
    required this.kind,
    required this.order,
    required this.status,
    this.description,
    this.programs = const [],
  });

  factory AcademicSection.fromJson(Map<String, Object?> json) =>
      AcademicSection(
        id: _required(json, 'id'),
        code: _required(json, 'code'),
        name: _required(json, 'name'),
        kind: SectionKind.fromWire(json['kind']),
        order: _int(json['order']),
        status: StructureStatus.fromWire(json['status']),
        description: _optional(json['description']),
        programs: _list(json['programs'], AcademicProgram.fromJson),
      );

  final String id;
  final String code;
  final String name;
  final SectionKind kind;
  final int order;
  final StructureStatus status;
  final String? description;
  final List<AcademicProgram> programs;

  /// `GET /academic/sections`' list; unreadable entries are skipped.
  static List<AcademicSection> listFromJson(Object? json) =>
      _list(json, AcademicSection.fromJson);

  bool get isActive => status == StructureStatus.active;

  /// ACTIVE halaqat across the section's ACTIVE programs.
  int get activeHalaqaCount => programs
      .where((program) => program.isActive)
      .fold(0, (sum, program) => sum + program.activeHalaqaCount);
}

/// A حلقة — the group students are enrolled in.
class AcademicHalaqa {
  const AcademicHalaqa({
    required this.id,
    required this.code,
    required this.programId,
    required this.name,
    required this.order,
    required this.status,
  });

  factory AcademicHalaqa.fromJson(Map<String, Object?> json) => AcademicHalaqa(
    id: _required(json, 'id'),
    code: _required(json, 'code'),
    programId: _required(json, 'programId'),
    name: _required(json, 'name'),
    order: _int(json['order']),
    status: StructureStatus.fromWire(json['status']),
  );

  final String id;
  final String code;
  final String programId;
  final String name;
  final int order;
  final StructureStatus status;

  bool get isActive => status == StructureStatus.active;
}

/// `GET /academic/programs/:id` — a program, its section and its halaqat.
class AcademicProgramDetail {
  const AcademicProgramDetail({
    required this.program,
    required this.section,
    required this.halaqat,
  });

  factory AcademicProgramDetail.fromJson(Map<String, Object?> json) =>
      AcademicProgramDetail(
        program: AcademicProgram.fromJson(_map(json['program'])),
        section: AcademicSection.fromJson(_map(json['section'])),
        halaqat: _list(json['halaqat'], AcademicHalaqa.fromJson),
      );

  final AcademicProgram program;
  final AcademicSection section;
  final List<AcademicHalaqa> halaqat;
}

/// A program or halaqa as a relationship refers to it.
class AcademicRef {
  const AcademicRef({
    required this.id,
    required this.code,
    required this.name,
    required this.order,
    required this.status,
  });

  factory AcademicRef.fromJson(Map<String, Object?> json) => AcademicRef(
    id: _required(json, 'id'),
    code: _required(json, 'code'),
    name: _required(json, 'name'),
    order: _int(json['order']),
    status: StructureStatus.fromWire(json['status']),
  );

  final String id;
  final String code;
  final String name;
  final int order;
  final StructureStatus status;
}

/// A section as a relationship refers to it — with its kind.
class AcademicSectionRef extends AcademicRef {
  const AcademicSectionRef({
    required super.id,
    required super.code,
    required super.name,
    required super.order,
    required super.status,
    required this.kind,
  });

  factory AcademicSectionRef.fromJson(Map<String, Object?> json) {
    final ref = AcademicRef.fromJson(json);
    return AcademicSectionRef(
      id: ref.id,
      code: ref.code,
      name: ref.name,
      order: ref.order,
      status: ref.status,
      kind: SectionKind.fromWire(json['kind']),
    );
  }

  final SectionKind kind;
}

/// Where a halaqa sits: its section, its program, and itself.
class AcademicPlacement {
  const AcademicPlacement({
    required this.section,
    required this.program,
    required this.halaqa,
  });

  factory AcademicPlacement.fromJson(Map<String, Object?> json) =>
      AcademicPlacement(
        section: AcademicSectionRef.fromJson(_map(json['section'])),
        program: AcademicRef.fromJson(_map(json['program'])),
        halaqa: AcademicRef.fromJson(_map(json['halaqa'])),
      );

  final AcademicSectionRef section;
  final AcademicRef program;
  final AcademicRef halaqa;
}

/// `GET /academic/halaqat/:id` — a halaqa and where it sits.
class AcademicHalaqaDetail {
  const AcademicHalaqaDetail({
    required this.halaqa,
    required this.program,
    required this.section,
  });

  factory AcademicHalaqaDetail.fromJson(Map<String, Object?> json) =>
      AcademicHalaqaDetail(
        halaqa: AcademicHalaqa.fromJson(_map(json['halaqa'])),
        program: AcademicRef.fromJson(_map(json['program'])),
        section: AcademicSectionRef.fromJson(_map(json['section'])),
      );

  final AcademicHalaqa halaqa;
  final AcademicRef program;
  final AcademicSectionRef section;
}

/// A student's enrollment in one halaqa. Who enrolled whom is administrative
/// metadata: the server never sends it to a student, and it is not modelled.
class AcademicEnrollment {
  const AcademicEnrollment({
    required this.id,
    required this.halaqaId,
    required this.status,
    required this.enrolledAt,
    this.endedAt,
  });

  factory AcademicEnrollment.fromJson(Map<String, Object?> json) =>
      AcademicEnrollment(
        id: _required(json, 'id'),
        halaqaId: _required(json, 'halaqaId'),
        status: EnrollmentStatus.fromWire(json['status']),
        enrolledAt: _instant(json, 'enrolledAt'),
        endedAt: _optionalInstant(json['endedAt']),
      );

  final String id;
  final String halaqaId;
  final EnrollmentStatus status;
  final DateTime enrolledAt;
  final DateTime? endedAt;

  bool get isActive => status == EnrollmentStatus.active;
}

/// A teacher's assignment to one halaqa.
class AcademicAssignment {
  const AcademicAssignment({
    required this.id,
    required this.halaqaId,
    required this.role,
    required this.status,
    required this.startedAt,
    this.endedAt,
  });

  factory AcademicAssignment.fromJson(Map<String, Object?> json) =>
      AcademicAssignment(
        id: _required(json, 'id'),
        halaqaId: _required(json, 'halaqaId'),
        role: TeachingRole.fromWire(json['role']),
        status: AssignmentStatus.fromWire(json['status']),
        startedAt: _instant(json, 'startedAt'),
        endedAt: _optionalInstant(json['endedAt']),
      );

  final String id;
  final String halaqaId;
  final TeachingRole role;
  final AssignmentStatus status;
  final DateTime startedAt;
  final DateTime? endedAt;

  bool get isActive => status == AssignmentStatus.active;
}

/// Someone teaching one of the student's own halaqat — a display name and a
/// role, nothing else. The name is null when the account is gone.
class HalaqaTeacher {
  const HalaqaTeacher({
    required this.userId,
    required this.role,
    this.displayName,
  });

  factory HalaqaTeacher.fromJson(Map<String, Object?> json) => HalaqaTeacher(
    userId: _required(json, 'userId'),
    role: TeachingRole.fromWire(json['role']),
    displayName: _optional(json['displayName']),
  );

  final String userId;
  final TeachingRole role;
  final String? displayName;
}

/// One of the student's own current enrollments, where it sits, and who
/// teaches it.
class MyEnrollment {
  const MyEnrollment({
    required this.enrollment,
    required this.placement,
    this.teachers = const [],
  });

  factory MyEnrollment.fromJson(Map<String, Object?> json) => MyEnrollment(
    enrollment: AcademicEnrollment.fromJson(_map(json['enrollment'])),
    placement: AcademicPlacement.fromJson(_map(json['placement'])),
    teachers: _list(json['teachers'], HalaqaTeacher.fromJson),
  );

  final AcademicEnrollment enrollment;
  final AcademicPlacement placement;
  final List<HalaqaTeacher> teachers;
}

/// One of the teacher's own current assignments, and where it sits.
class MyTeaching {
  const MyTeaching({required this.assignment, required this.placement});

  factory MyTeaching.fromJson(Map<String, Object?> json) => MyTeaching(
    assignment: AcademicAssignment.fromJson(_map(json['assignment'])),
    placement: AcademicPlacement.fromJson(_map(json['placement'])),
  );

  final AcademicAssignment assignment;
  final AcademicPlacement placement;
}

/// `GET /academic/me` — what the signed-in person studies and teaches, now.
///
/// There is no progress here: no percentage, no "3 of 10". None is recorded
/// yet, and none is invented.
class MyAcademic {
  const MyAcademic({
    this.enrollments = const [],
    this.teaching = const [],
    this.truncated = false,
  });

  factory MyAcademic.fromJson(Map<String, Object?> json) => MyAcademic(
    enrollments: _list(json['enrollments'], MyEnrollment.fromJson),
    teaching: _list(json['teaching'], MyTeaching.fromJson),
    truncated: json['truncated'] == true,
  );

  final List<MyEnrollment> enrollments;
  final List<MyTeaching> teaching;

  /// More relationships exist than the server lists at once.
  final bool truncated;

  /// Only what is ACTIVE — an unknown status is never taken for "current".
  List<MyEnrollment> get activeEnrollments =>
      enrollments.where((entry) => entry.enrollment.isActive).toList();

  List<MyTeaching> get activeTeaching =>
      teaching.where((entry) => entry.assignment.isActive).toList();
}

/// A refusal from `/academic`, with the server's stable code
/// (`academic.halaqa_access_denied`, `identity.authentication_required`, …).
class AcademicException implements Exception {
  const AcademicException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  @override
  String toString() => 'AcademicException($code): $message';
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

String _required(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.isNotEmpty) return value;
  throw FormatException('academic: missing "$key"');
}

String? _optional(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;

int _int(Object? value) => value is num ? value.toInt() : 0;

DateTime _instant(Map<String, Object?> json, String key) {
  final value = json[key];
  final parsed = value is String ? DateTime.tryParse(value) : null;
  if (parsed == null) throw FormatException('academic: missing "$key"');
  return parsed;
}

DateTime? _optionalInstant(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;

Map<String, Object?> _map(Object? value) {
  if (value is Map) return value.cast<String, Object?>();
  throw const FormatException('academic: expected an object');
}

/// Items that cannot be read are skipped, never fatal to the list.
List<T> _list<T>(Object? value, T Function(Map<String, Object?> json) parse) {
  if (value is! List) return const [];
  final items = <T>[];
  for (final item in value) {
    if (item is! Map) continue;
    try {
      items.add(parse(item.cast<String, Object?>()));
    } on FormatException {
      continue;
    } on TypeError {
      continue;
    }
  }
  return List.unmodifiable(items);
}
