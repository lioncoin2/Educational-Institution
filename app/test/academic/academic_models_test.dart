import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/academic.dart';

/// Academic wire models: exactly the server's shapes, parsed defensively — a
/// value this version does not know is "unknown" and never shown as open or
/// current; an item that cannot be identified is skipped, not fatal.
void main() {
  Map<String, Object?> program({
    String id = 'p1',
    Object? status = 'ACTIVE',
    Object? count = 10,
  }) => {
    'id': id,
    'code': 'dep-letters-program',
    'sectionId': 's1',
    'name': 'قسم تلقين الحروف',
    'order': 1,
    'description': null,
    'status': status,
    'activeHalaqaCount': count,
    'createdAt': '2026-09-01T08:00:00.000Z',
    'updatedAt': '2026-09-01T08:00:00.000Z',
  };

  Map<String, Object?> section({
    Object? kind = 'PROGRESSIVE',
    Object? status = 'ACTIVE',
    List<Object?>? programs,
  }) => {
    'id': 's1',
    'code': 'dep-letters',
    'name': 'قسم تلقين الحروف',
    'kind': kind,
    'order': 2,
    'description': '  ',
    'status': status,
    'programs': programs ?? [program()],
  };

  test('reads a catalogue section with its programs and counts', () {
    final parsed = AcademicSection.fromJson(section());
    expect(parsed.code, 'dep-letters');
    expect(parsed.kind, SectionKind.progressive);
    expect(parsed.isActive, isTrue);
    expect(parsed.description, isNull, reason: 'blank is not a description');
    expect(parsed.programs.single.activeHalaqaCount, 10);
    expect(parsed.activeHalaqaCount, 10);
  });

  test('counts only ACTIVE programs’ halaqat', () {
    final parsed = AcademicSection.fromJson(
      section(
        programs: [
          program(),
          program(id: 'p2', status: 'INACTIVE'),
        ],
      ),
    );
    expect(parsed.activeHalaqaCount, 10);
  });

  test('keeps what it does not know as unknown — never as active', () {
    final parsed = AcademicSection.fromJson(
      section(kind: 'FUTURE_KIND', status: 'ARCHIVED'),
    );
    expect(parsed.kind, SectionKind.unknown);
    expect(parsed.status, StructureStatus.unknown);
    expect(parsed.isActive, isFalse);
    expect(StructureStatus.fromWire(null), StructureStatus.unknown);
    expect(EnrollmentStatus.fromWire('PAUSED'), EnrollmentStatus.unknown);
    expect(TeachingRole.fromWire('HEAD_TEACHER'), TeachingRole.unknown);
    expect(AssignmentStatus.fromWire(42), AssignmentStatus.unknown);
  });

  test(
    'skips list items it cannot identify, and refuses a section it cannot',
    () {
      final list = AcademicSection.listFromJson([
        section(),
        {'id': 's2', 'name': 'no code'},
        'not an object',
        section(
          programs: [
            program(),
            {'id': 'broken'},
          ],
        ),
      ]);
      expect(list, hasLength(2));
      expect(list.last.programs, hasLength(1));
      expect(
        () => AcademicSection.fromJson({'code': 'x', 'name': 'y'}),
        throwsFormatException,
      );
      expect(AcademicSection.listFromJson(null), isEmpty);
    },
  );

  test('treats a non-numeric count as none, not as a crash', () {
    expect(
      AcademicProgram.fromJson(program(count: 'ten')).activeHalaqaCount,
      0,
    );
  });

  group('my academic record', () {
    Map<String, Object?> placement() => {
      'section': {
        'id': 's1',
        'code': 'dep-tajweed-2',
        'name': 'قسم تجويد متوسط',
        'kind': 'PROGRESSIVE',
        'order': 4,
        'status': 'ACTIVE',
      },
      'program': {
        'id': 'p1',
        'code': 'dep-tajweed-2-program',
        'name': 'قسم تجويد متوسط',
        'order': 1,
        'status': 'ACTIVE',
      },
      'halaqa': {
        'id': 'h1',
        'code': 'dep-tajweed-2-h3',
        'name': 'الحلقة 3',
        'order': 3,
        'status': 'ACTIVE',
      },
    };

    Map<String, Object?> enrollment({Object? status = 'ACTIVE'}) => {
      'enrollment': {
        'id': 'e1',
        'studentUserId': 'u1',
        'halaqaId': 'h1',
        'status': status,
        'enrolledAt': '2026-09-01T08:00:00.000Z',
        'endedAt': null,
      },
      'placement': placement(),
      'teachers': [
        {'userId': 't1', 'displayName': 'الأستاذة عائشة', 'role': 'TEACHER'},
        {'userId': 't2', 'displayName': null, 'role': 'ASSISTANT_TEACHER'},
      ],
    };

    test('reads enrollments with where they sit and who teaches them', () {
      final mine = MyAcademic.fromJson({
        'enrollments': [enrollment()],
        'teaching': [
          {
            'assignment': {
              'id': 'a1',
              'halaqaId': 'h1',
              'teacherUserId': 'u1',
              'role': 'TEACHER',
              'status': 'ACTIVE',
              'startedAt': '2026-09-01T08:00:00.000Z',
              'endedAt': null,
            },
            'placement': placement(),
          },
        ],
        'truncated': false,
      });
      final [entry] = mine.activeEnrollments;
      expect(entry.placement.section.kind, SectionKind.progressive);
      expect(entry.placement.halaqa.name, 'الحلقة 3');
      expect(entry.enrollment.enrolledAt, DateTime.utc(2026, 9, 1, 8));
      expect(
        [for (final t in entry.teachers) (t.displayName, t.role)],
        [
          ('الأستاذة عائشة', TeachingRole.teacher),
          (null, TeachingRole.assistantTeacher),
        ],
      );
      expect(mine.activeTeaching.single.assignment.role, TeachingRole.teacher);
      expect(mine.truncated, isFalse);
    });

    test(
      'never takes an enrollment of an unknown status for a current one',
      () {
        final mine = MyAcademic.fromJson({
          'enrollments': [enrollment(status: 'PAUSED')],
        });
        expect(mine.enrollments, hasLength(1));
        expect(mine.activeEnrollments, isEmpty);
      },
    );

    test('skips an enrollment without a date or a placement', () {
      final undated = enrollment();
      (undated['enrollment']! as Map)['enrolledAt'] = 'yesterday';
      final unplaced = enrollment()..remove('placement');
      final mine = MyAcademic.fromJson({
        'enrollments': [undated, unplaced, enrollment()],
      });
      expect(mine.enrollments, hasLength(1));
    });

    test('is empty — not an error — when there is nothing', () {
      final mine = MyAcademic.fromJson(const {});
      expect(mine.enrollments, isEmpty);
      expect(mine.teaching, isEmpty);
      expect(mine.truncated, isFalse);
    });
  });

  test('says when a refusal needs a sign-in', () {
    expect(
      const AcademicException(
        'identity.authentication_required',
        '',
      ).needsSignIn,
      isTrue,
    );
    expect(
      const AcademicException('network.unreachable', '').isNetwork,
      isTrue,
    );
  });
}
