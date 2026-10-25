import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/models/program.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The Programs tab against an institution's OWN records (as the Trial is: its
/// sections were created in academic administration, with codes like `q2`, not
/// the demo profile's `dep-tajweed-2`). Before: every study-field card and the
/// «استكشف البرامج» button routed to a fixed demo code the records do not have,
/// so each ended on «لم نجد هذا القسم», and the real sections were nowhere on
/// the tab Home's «عرض جميع الأقسام/البرامج» opens. Now the tab lists the real
/// catalogue, and nothing leads to a not-found page.
class _OwnRecords implements CatalogRepository {
  static const departments = [
    Program(
      id: 'q2',
      name: 'قسم الحفظ المتدرّج',
      kind: ProgramKind.department,
      halaqatCount: 2,
    ),
    Program(
      id: 'wajdi-1',
      name: 'قسم التجويد',
      kind: ProgramKind.department,
      halaqatCount: 1,
    ),
  ];
  static const specials = [
    Program(
      id: 'sec-1791982479',
      name: 'قسم البراعم',
      kind: ProgramKind.special,
      halaqatCount: 1,
    ),
  ];
  static const companions = <Program>[];

  @override
  Future<List<Program>> getDepartments() async => departments;
  @override
  Future<List<Program>> getSpecialSections() async => specials;
  @override
  Future<List<Program>> getCompanionPrograms() async => companions;
  @override
  Future<Program?> getProgram(String id) async => [
    ...departments,
    ...specials,
    ...companions,
  ].where((p) => p.id == id).firstOrNull;
}

void main() {
  late ProviderContainer container;

  String location() => container
      .read(routerProvider)
      .routerDelegate
      .currentConfiguration
      .last
      .matchedLocation;

  Future<void> openPrograms(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    container = ProviderContainer(
      overrides: [catalogRepositoryProvider.overrideWithValue(_OwnRecords())],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const QuranInstitutionApp(),
      ),
    );
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    container.read(routerProvider).go('/programs');
    await tester.pumpAndSettle();
  }

  Future<void> tapVisible(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder.first);
    await tester.pumpAndSettle();
    await tester.tap(finder.first);
    await tester.pumpAndSettle();
  }

  testWidgets('the tab lists the institution\'s real sections', (tester) async {
    await openPrograms(tester);
    for (final program in [
      ..._OwnRecords.departments,
      ..._OwnRecords.specials,
    ]) {
      expect(find.text(program.name), findsOneWidget, reason: program.id);
    }
    expect(find.text('الأقسام التعليمية'), findsOneWidget);
    expect(find.text('الأقسام الخاصة'), findsOneWidget);
    // An empty group is not shown as an empty heading.
    expect(find.text('البرامج المرافقة'), findsNothing);
  });

  testWidgets('a real section opens its own page — never «لم نجد»', (
    tester,
  ) async {
    await openPrograms(tester);
    await tapVisible(tester, find.text('قسم التجويد'));
    expect(location(), '/programs/wajdi-1');
    expect(find.textContaining('لم نجد'), findsNothing);
  });

  testWidgets('a study field with no program in these records says so, and '
      'does not route to a not-found page', (tester) async {
    await openPrograms(tester);
    await tapVisible(tester, find.text('التجويد والقراءات'));
    expect(location(), '/programs');
    expect(
      find.textContaining('لا يرتبط هذا المجال ببرنامج بعد'),
      findsOneWidget,
    );
    expect(find.textContaining('لم نجد'), findsNothing);
  });

  testWidgets('«استكشف البرامج» opens a program that exists', (tester) async {
    await openPrograms(tester);
    await tapVisible(tester, find.text('استكشف البرامج'));
    expect(location(), '/programs/q2');
    expect(find.textContaining('لم نجد'), findsNothing);
  });
}
