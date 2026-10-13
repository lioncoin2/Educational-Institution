import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/academic_admin/academic_admin_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// Managing the academic structure in the app: a holder of `academic.manage`
/// sees the tree with its controls and can create, edit, activate and
/// deactivate; a viewer without it sees the tree alone. Every write goes to the
/// server (the fake here), which stays the authority; a refusal is said in
/// words. Enrolling students is not offered anywhere here.
class _FakeAcademic implements AcademicRepository {
  _FakeAcademic({this.failWith});

  /// When set, every write is refused with this code.
  String? failWith;
  final List<String> writes = [];

  final List<Map<String, Object?>> _sections = [
    {
      'id': 's:1',
      'code': 'tajweed',
      'name': 'قسم التجويد',
      'kind': 'SPECIAL',
      'order': 1,
      'status': 'ACTIVE',
      'description': null,
      'programs': [
        {
          'id': 'p:1',
          'code': 'prog',
          'sectionId': 's:1',
          'name': 'برنامج التجويد',
          'order': 1,
          'status': 'ACTIVE',
          'activeHalaqaCount': 1,
          'description': null,
        },
      ],
    },
  ];
  final Map<String, List<Map<String, Object?>>> _halaqat = {
    'p:1': [
      {
        'id': 'h:1',
        'code': 'h1',
        'programId': 'p:1',
        'name': 'حلقة ألف',
        'order': 1,
        'status': 'ACTIVE',
      },
    ],
  };

  void _maybeFail() {
    final code = failWith;
    if (code != null) throw AcademicException(code, code);
  }

  @override
  DataOrigin get origin => DataOrigin.records;

  @override
  Future<List<AcademicSection>> catalogue() async =>
      AcademicSection.listFromJson(_sections);

  @override
  Future<AcademicProgramDetail?> program(String id) async {
    for (final section in _sections) {
      for (final program
          in (section['programs']! as List).cast<Map<String, Object?>>()) {
        if (program['id'] == id) {
          return AcademicProgramDetail.fromJson({
            'program': program,
            'section': {...section}..remove('programs'),
            'halaqat': _halaqat[id] ?? const <Object?>[],
          });
        }
      }
    }
    return null;
  }

  @override
  Future<AcademicHalaqaDetail?> halaqa(String id) async => null;

  @override
  Future<MyAcademic> me() async => const MyAcademic();

  @override
  Future<AcademicSection> createSection({
    required String code,
    required String name,
    required int order,
    required SectionKind kind,
    String? description,
  }) async {
    writes.add('createSection $code');
    _maybeFail();
    final row = {
      'id': 's:$code',
      'code': code,
      'name': name,
      'kind': kind.wire,
      'order': order,
      'status': 'ACTIVE',
      'description': description,
      'programs': <Object?>[],
    };
    _sections.add(row);
    return AcademicSection.fromJson(row);
  }

  @override
  Future<AcademicSection> updateSection(
    String id, {
    required String name,
    required int order,
    String? description,
  }) async {
    writes.add('updateSection $id');
    _maybeFail();
    final section = _sections.firstWhere((e) => e['id'] == id);
    section['name'] = name;
    section['order'] = order;
    section['description'] = description;
    return AcademicSection.fromJson(section);
  }

  @override
  Future<AcademicSection> setSectionActive(
    String id, {
    required bool active,
  }) async {
    writes.add('setSectionActive $id $active');
    _maybeFail();
    final section = _sections.firstWhere((e) => e['id'] == id);
    section['status'] = active ? 'ACTIVE' : 'INACTIVE';
    return AcademicSection.fromJson(section);
  }

  @override
  Future<AcademicProgram> createProgram({
    required String sectionId,
    required String code,
    required String name,
    required int order,
    String? description,
  }) async {
    writes.add('createProgram $sectionId $code');
    _maybeFail();
    final row = {
      'id': 'p:$code',
      'code': code,
      'sectionId': sectionId,
      'name': name,
      'order': order,
      'status': 'ACTIVE',
      'activeHalaqaCount': 0,
      'description': description,
    };
    final section = _sections.firstWhere((e) => e['id'] == sectionId);
    (section['programs']! as List).add(row);
    return AcademicProgram.fromJson(row);
  }

  @override
  Future<AcademicProgram> updateProgram(
    String id, {
    required String name,
    required int order,
    String? description,
  }) async {
    writes.add('updateProgram $id');
    _maybeFail();
    final program = _findProgram(id);
    program['name'] = name;
    program['order'] = order;
    program['description'] = description;
    return AcademicProgram.fromJson(program);
  }

  @override
  Future<AcademicProgram> setProgramActive(
    String id, {
    required bool active,
  }) async {
    writes.add('setProgramActive $id $active');
    _maybeFail();
    final program = _findProgram(id);
    program['status'] = active ? 'ACTIVE' : 'INACTIVE';
    return AcademicProgram.fromJson(program);
  }

  @override
  Future<AcademicHalaqa> createHalaqa({
    required String programId,
    required String code,
    required String name,
    required int order,
  }) async {
    writes.add('createHalaqa $programId $code');
    _maybeFail();
    final row = {
      'id': 'h:$code',
      'code': code,
      'programId': programId,
      'name': name,
      'order': order,
      'status': 'ACTIVE',
    };
    (_halaqat[programId] ??= []).add(row);
    return AcademicHalaqa.fromJson(row);
  }

  @override
  Future<AcademicHalaqa> updateHalaqa(
    String id, {
    required String name,
    required int order,
  }) async {
    writes.add('updateHalaqa $id');
    _maybeFail();
    final halaqa = _findHalaqa(id);
    halaqa['name'] = name;
    halaqa['order'] = order;
    return AcademicHalaqa.fromJson(halaqa);
  }

  @override
  Future<AcademicHalaqa> setHalaqaActive(
    String id, {
    required bool active,
  }) async {
    writes.add('setHalaqaActive $id $active');
    _maybeFail();
    final halaqa = _findHalaqa(id);
    halaqa['status'] = active ? 'ACTIVE' : 'INACTIVE';
    return AcademicHalaqa.fromJson(halaqa);
  }

  Map<String, Object?> _findProgram(String id) {
    for (final section in _sections) {
      for (final program
          in (section['programs']! as List).cast<Map<String, Object?>>()) {
        if (program['id'] == id) return program;
      }
    }
    throw StateError('no program $id');
  }

  Map<String, Object?> _findHalaqa(String id) {
    for (final list in _halaqat.values) {
      for (final halaqa in list) {
        if (halaqa['id'] == id) return halaqa;
      }
    }
    throw StateError('no halaqa $id');
  }
}

CurrentUser _user(Set<String> permissions) => CurrentUser(
  id: 'me',
  displayName: 'مسؤولة',
  status: AccountStatus.active,
  roles: const [],
  permissions: permissions,
);

void main() {
  final addSection = find.byKey(const Key('academic-add-section-fab'));
  final addHalaqa = find.byKey(const Key('academic-add-halaqa-fab'));
  final codeField = find.byKey(const Key('structure-form-code'));
  final submit = find.byKey(const Key('structure-form-submit'));

  List<Override> overrides(AcademicRepository repo, CurrentUser user) => [
    academicRepositoryProvider.overrideWithValue(repo),
    backendModeProvider.overrideWithValue(true),
    sessionUserProvider.overrideWith((ref) async => user),
  ];

  Future<void> openStructure(
    WidgetTester tester, {
    required AcademicRepository repo,
    required CurrentUser user,
  }) => openApp(
    tester,
    Routes.academicStructure,
    overrides: overrides(repo, user),
  );

  testWidgets('lists sections and their programs', (tester) async {
    await openStructure(
      tester,
      repo: _FakeAcademic(),
      user: _user({'academic.manage'}),
    );
    expect(find.text('قسم التجويد'), findsOneWidget);
    expect(find.text('برنامج التجويد'), findsOneWidget);
  });

  testWidgets('offers the controls to a holder of academic.manage', (
    tester,
  ) async {
    await openStructure(
      tester,
      repo: _FakeAcademic(),
      user: _user({'academic.manage', 'academic.read'}),
    );
    expect(addSection, findsOneWidget);
    expect(find.text(AcademicAdminCopy.addProgram), findsOneWidget);
    expect(find.byIcon(Icons.more_vert), findsWidgets);
  });

  testWidgets('withholds every control from a viewer without academic.manage', (
    tester,
  ) async {
    await openStructure(
      tester,
      repo: _FakeAcademic(),
      user: _user({'academic.read'}),
    );
    // The tree is still readable…
    expect(find.text('قسم التجويد'), findsOneWidget);
    // …but nothing that writes is offered.
    expect(addSection, findsNothing);
    expect(find.text(AcademicAdminCopy.addProgram), findsNothing);
    expect(find.byIcon(Icons.more_vert), findsNothing);
  });

  testWidgets(
    'creates a section — asks the server, shows it, closes the sheet',
    (tester) async {
      final repo = _FakeAcademic();
      await openStructure(tester, repo: repo, user: _user({'academic.manage'}));

      await tester.tap(addSection);
      await tester.pumpAndSettle();

      await tester.enterText(codeField, 'tajweed-2');
      await tester.enterText(
        find.byKey(const Key('structure-form-name')),
        'قسم جديد',
      );
      await tester.enterText(
        find.byKey(const Key('structure-form-order')),
        '2',
      );
      await tester.tap(find.byKey(const Key('structure-form-kind')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.text(AcademicAdminCopy.kind(SectionKind.special)).last,
      );
      await tester.pumpAndSettle();

      await tester.tap(submit);
      await tester.pumpAndSettle();

      expect(repo.writes, contains('createSection tajweed-2'));
      expect(find.text(AcademicAdminCopy.created), findsOneWidget);
      expect(codeField, findsNothing); // the sheet closed
      expect(find.text('قسم جديد'), findsOneWidget); // and the list refreshed
    },
  );

  testWidgets('a refused create is said in words, and the sheet stays open', (
    tester,
  ) async {
    final repo = _FakeAcademic(failWith: 'academic.code_taken');
    await openStructure(tester, repo: repo, user: _user({'academic.manage'}));

    await tester.tap(addSection);
    await tester.pumpAndSettle();
    await tester.enterText(codeField, 'tajweed');
    await tester.enterText(find.byKey(const Key('structure-form-name')), 'قسم');
    await tester.enterText(find.byKey(const Key('structure-form-order')), '2');
    await tester.tap(find.byKey(const Key('structure-form-kind')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.text(AcademicAdminCopy.kind(SectionKind.progressive)).last,
    );
    await tester.pumpAndSettle();
    await tester.tap(submit);
    await tester.pumpAndSettle();

    expect(
      find.text(AcademicAdminCopy.changeFailed('academic.code_taken')),
      findsOneWidget,
    );
    expect(codeField, findsOneWidget); // still open to correct
  });

  testWidgets('deactivating a section asks first, then tells the server', (
    tester,
  ) async {
    final repo = _FakeAcademic();
    await openStructure(tester, repo: repo, user: _user({'academic.manage'}));

    await tester.tap(find.byIcon(Icons.more_vert).first); // the section's menu
    await tester.pumpAndSettle();
    await tester.tap(find.text(AcademicAdminCopy.deactivate));
    await tester.pumpAndSettle();

    // A confirm step stands between the tap and the write.
    expect(repo.writes, isEmpty);
    await tester.tap(
      find.widgetWithText(FilledButton, AcademicAdminCopy.confirmDeactivate),
    );
    await tester.pumpAndSettle();

    expect(repo.writes, contains('setSectionActive s:1 false'));
    expect(find.text(AcademicAdminCopy.deactivated), findsOneWidget);
  });

  testWidgets('opens a program to manage its halaqat', (tester) async {
    await openStructure(
      tester,
      repo: _FakeAcademic(),
      user: _user({'academic.manage'}),
    );
    await tester.tap(find.text('برنامج التجويد'));
    await tester.pumpAndSettle();

    expect(find.text('حلقة ألف'), findsOneWidget);
    expect(addHalaqa, findsOneWidget);
  });

  testWidgets('adds a halaqa to a program', (tester) async {
    final repo = _FakeAcademic();
    await openApp(
      tester,
      Routes.academicProgram('p:1'),
      overrides: overrides(repo, _user({'academic.manage'})),
    );
    await tester.pumpAndSettle();

    expect(find.text('حلقة ألف'), findsOneWidget);
    await tester.tap(addHalaqa);
    await tester.pumpAndSettle();

    await tester.enterText(codeField, 'h2');
    await tester.enterText(
      find.byKey(const Key('structure-form-name')),
      'حلقة باء',
    );
    await tester.enterText(find.byKey(const Key('structure-form-order')), '2');
    await tester.pump(); // let the form re-enable its submit
    await tester.tap(submit);
    await tester.pumpAndSettle();

    expect(repo.writes, contains('createHalaqa p:1 h2'));
    expect(find.text(AcademicAdminCopy.created), findsOneWidget);
    expect(find.text('حلقة باء'), findsOneWidget);
  });
}
