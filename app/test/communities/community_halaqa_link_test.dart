import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// The optional halaqa link (Q50) on the community management surface: shown
/// only where the server's `me.canManageHalaqa` holds (institutional
/// oversight), linked from the academic catalogue, unlinked after asking, and
/// refused in words without a reason. The server is authoritative; a hidden
/// control is never the authorization.
void main() {
  const owned = MockCommunityRepository.ownedId;
  const open = MockCommunityRepository.openId;

  late ScriptedCommunities repo;

  const signedIn = CurrentUser(
    id: viewer,
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: [],
    permissions: {},
  );

  Future<void> openAt(
    WidgetTester tester,
    String path, {
    List<Override> extra = const [],
  }) async {
    await openApp(
      tester,
      path,
      size: const Size(390, 2400),
      overrides: [
        communityRepositoryProvider.overrideWithValue(repo),
        academicRepositoryProvider.overrideWithValue(_FakeAcademic()),
        messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
        sessionUserProvider.overrideWith((ref) async => signedIn),
        ...extra,
      ],
    );
  }

  setUp(() => repo = ScriptedCommunities());

  testWidgets('is offered to oversight (the owner here)', (tester) async {
    await openAt(tester, '/communities/$owned');
    expect(find.text(CommunityCopy.halaqaTitle), findsOneWidget);
    expect(find.text(CommunityCopy.linkHalaqa), findsOneWidget);
    expect(find.text(CommunityCopy.halaqaNone), findsOneWidget);
    // Nothing is linked yet, so there is nothing to unlink.
    expect(find.text(CommunityCopy.unlinkHalaqa), findsNothing);
  });

  testWidgets('is withheld from a plain member', (tester) async {
    await openAt(tester, '/communities/$open');
    expect(find.text(CommunityCopy.halaqaTitle), findsNothing);
    expect(find.text(CommunityCopy.linkHalaqa), findsNothing);
  });

  testWidgets('links a halaqa chosen from the academic catalogue, then shows it', (tester) async {
    await openAt(tester, '/communities/$owned');
    await tester.ensureVisible(find.text(CommunityCopy.linkHalaqa));
    await tester.tap(find.text(CommunityCopy.linkHalaqa));
    await tester.pumpAndSettle();

    // The picker browses the catalogue — structure only.
    expect(find.text(CommunityCopy.halaqaPickerTitle), findsOneWidget);
    await tester.tap(find.text('برنامج التجويد')); // open the program
    await tester.pumpAndSettle();
    await tester.tap(find.text('حلقة ألف')); // choose a halaqa
    await tester.pumpAndSettle();

    // Exactly one link request, carrying the chosen halaqa's id.
    expect(repo.writes, contains('linkHalaqa $owned hal-1'));
    // The community now shows the association, resolved to the halaqa's name.
    expect(find.text(CommunityCopy.changeHalaqa), findsOneWidget);
    expect(find.text(CommunityCopy.halaqaLinked('حلقة ألف')), findsOneWidget);
  });

  testWidgets('unlinks after asking, and shows it unlinked', (tester) async {
    await repo.linkHalaqa(owned, 'hal-2'); // already linked
    await openAt(tester, '/communities/$owned');
    expect(find.text(CommunityCopy.unlinkHalaqa), findsOneWidget);

    await tester.ensureVisible(find.text(CommunityCopy.unlinkHalaqa));
    await tester.tap(find.text(CommunityCopy.unlinkHalaqa));
    await tester.pumpAndSettle();
    await tester.tap(find.text(CommunityCopy.confirmUnlinkHalaqa));
    await tester.pumpAndSettle();

    expect(repo.writes, contains('unlinkHalaqa $owned'));
    // Back to offering a link, with nothing linked.
    expect(find.text(CommunityCopy.linkHalaqa), findsOneWidget);
    expect(find.text(CommunityCopy.halaqaNone), findsOneWidget);
  });

  testWidgets('says why, without a reason, when the server refuses the change', (tester) async {
    await repo.linkHalaqa(owned, 'hal-1'); // already linked
    await openAt(tester, '/communities/$owned');
    repo.failWritesWith = 'communities.halaqa_not_found';

    await tester.ensureVisible(find.text(CommunityCopy.unlinkHalaqa));
    await tester.tap(find.text(CommunityCopy.unlinkHalaqa));
    await tester.pumpAndSettle();
    await tester.tap(find.text(CommunityCopy.confirmUnlinkHalaqa));
    await tester.pumpAndSettle();

    expect(
      find.text(CommunityCopy.writeFailed('communities.halaqa_not_found')),
      findsOneWidget,
    );
  });
}

/// A tiny academic catalogue for the picker and the link's name resolution:
/// one section, one program, two halaqat — structure only, no student or
/// teacher. Built through the real wire parsers, so it reads as the server's
/// would.
class _FakeAcademic implements AcademicRepository {
  @override
  DataOrigin get origin => DataOrigin.records;

  static final AcademicSection _section = AcademicSection.fromJson({
    'id': 'sec-1',
    'code': 'sec',
    'name': 'قسم التجويد',
    'kind': 'SPECIAL',
    'order': 1,
    'status': 'ACTIVE',
    'programs': [
      {
        'id': 'prog-1',
        'code': 'prog',
        'sectionId': 'sec-1',
        'name': 'برنامج التجويد',
        'order': 1,
        'status': 'ACTIVE',
        'activeHalaqaCount': 2,
      },
    ],
  });

  static final List<AcademicHalaqa> _halaqat = [
    AcademicHalaqa.fromJson({
      'id': 'hal-1',
      'code': 'h1',
      'programId': 'prog-1',
      'name': 'حلقة ألف',
      'order': 1,
      'status': 'ACTIVE',
    }),
    AcademicHalaqa.fromJson({
      'id': 'hal-2',
      'code': 'h2',
      'programId': 'prog-1',
      'name': 'حلقة باء',
      'order': 2,
      'status': 'ACTIVE',
    }),
  ];

  @override
  Future<List<AcademicSection>> catalogue() async => [_section];

  @override
  Future<AcademicProgramDetail?> program(String programId) async =>
      programId == 'prog-1'
      ? AcademicProgramDetail(
          program: _section.programs.first,
          section: _section,
          halaqat: _halaqat,
        )
      : null;

  @override
  Future<AcademicHalaqaDetail?> halaqa(String halaqaId) async {
    for (final h in _halaqat) {
      if (h.id == halaqaId) {
        return AcademicHalaqaDetail.fromJson({
          'halaqa': {
            'id': h.id,
            'code': h.code,
            'programId': h.programId,
            'name': h.name,
            'order': h.order,
            'status': 'ACTIVE',
          },
          'program': {
            'id': 'prog-1',
            'code': 'prog',
            'name': 'برنامج التجويد',
            'order': 1,
            'status': 'ACTIVE',
          },
          'section': {
            'id': 'sec-1',
            'code': 'sec',
            'name': 'قسم التجويد',
            'order': 1,
            'status': 'ACTIVE',
            'kind': 'SPECIAL',
          },
        });
      }
    }
    return null;
  }

  @override
  Future<MyAcademic> me() => throw UnimplementedError();

  @override
  Future<AcademicSection> createSection({
    required String code,
    required String name,
    required int order,
    required SectionKind kind,
    String? description,
  }) => throw UnimplementedError();

  @override
  Future<AcademicSection> updateSection(
    String sectionId, {
    required String name,
    required int order,
    String? description,
  }) => throw UnimplementedError();

  @override
  Future<AcademicSection> setSectionActive(
    String sectionId, {
    required bool active,
  }) => throw UnimplementedError();

  @override
  Future<AcademicProgram> createProgram({
    required String sectionId,
    required String code,
    required String name,
    required int order,
    String? description,
  }) => throw UnimplementedError();

  @override
  Future<AcademicProgram> updateProgram(
    String programId, {
    required String name,
    required int order,
    String? description,
  }) => throw UnimplementedError();

  @override
  Future<AcademicProgram> setProgramActive(
    String programId, {
    required bool active,
  }) => throw UnimplementedError();

  @override
  Future<AcademicHalaqa> createHalaqa({
    required String programId,
    required String code,
    required String name,
    required int order,
  }) => throw UnimplementedError();

  @override
  Future<AcademicHalaqa> updateHalaqa(
    String halaqaId, {
    required String name,
    required int order,
  }) => throw UnimplementedError();

  @override
  Future<AcademicHalaqa> setHalaqaActive(
    String halaqaId, {
    required bool active,
  }) => throw UnimplementedError();
}
