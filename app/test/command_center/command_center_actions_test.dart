import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/command_center.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/command_center/command_center_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

class _FakeReporting implements ReportingRepository {
  _FakeReporting(this._center);
  final CommandCenter _center;
  @override
  Future<CommandCenter> commandCenter() async => _center;
}

void main() {
  group('CommandCenter model parses actions', () {
    test('reads the actions array alongside widgets', () {
      final center = CommandCenter.fromJson(const {
        'widgets': [],
        'actions': [
          {'id': 'publish.communities', 'title': 'النشر إلى عدة مجتمعات'},
          {'id': 'accounts.admin', 'title': 'إدارة الحسابات'},
        ],
      });
      expect(center.actions.map((a) => a.id).toList(), [
        'publish.communities',
        'accounts.admin',
      ]);
      expect(center.isEmpty, isFalse); // actions alone are content
    });

    test('a missing actions array is an empty list, not a crash', () {
      final center = CommandCenter.fromJson(const {'widgets': []});
      expect(center.actions, isEmpty);
      expect(center.isEmpty, isTrue);
    });
  });

  group('routeForCommandAction', () {
    test('maps every known action to a real route', () {
      expect(routeForCommandAction('publish.communities'), Routes.publish);
      expect(routeForCommandAction('communities.create'), Routes.communities);
      expect(
        routeForCommandAction('academic.structure'),
        Routes.academicStructure,
      );
      expect(routeForCommandAction('accounts.admin'), Routes.adminAccounts);
    });

    test('an unknown action has no route (shown but not navigable)', () {
      expect(routeForCommandAction('something.new'), isNull);
    });
  });

  testWidgets('renders the actions section and the accounts widget', (
    tester,
  ) async {
    final center = CommandCenter.fromJson(const {
      'actions': [
        {'id': 'publish.communities', 'title': 'النشر إلى عدة مجتمعات'},
      ],
      'widgets': [
        {
          'id': 'accounts.summary',
          'category': 'today',
          'title': 'الحسابات',
          'payload': {
            'metrics': [
              {'key': 'total', 'label': 'إجمالي الحسابات', 'value': 128},
            ],
          },
        },
      ],
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          reportingRepositoryProvider.overrideWithValue(_FakeReporting(center)),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: MaterialApp(
          home: const CommandCenterScreen(),
          builder: (context, child) =>
              Directionality(textDirection: TextDirection.rtl, child: child!),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The actions section row, keyed by the action id.
    expect(
      find.byKey(const Key('command-action-publish.communities')),
      findsOneWidget,
    );
    // The accounts widget renders its real metric.
    expect(find.text('الحسابات'), findsOneWidget);
    expect(find.text('إجمالي الحسابات'), findsOneWidget);
    expect(find.text('128'), findsOneWidget);
  });

  testWidgets('tapping an action this build has no screen for says so', (
    tester,
  ) async {
    final center = CommandCenter.fromJson(const {
      'widgets': [],
      'actions': [
        {'id': 'future.action', 'title': 'إجراء مستقبلي'},
      ],
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          reportingRepositoryProvider.overrideWithValue(_FakeReporting(center)),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: MaterialApp(
          home: const CommandCenterScreen(),
          builder: (context, child) =>
              Directionality(textDirection: TextDirection.rtl, child: child!),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('command-action-future.action')));
    await tester.pumpAndSettle();
    expect(
      find.text('هذا الإجراء غير متاح في هذا التطبيق بعد.'),
      findsOneWidget,
    );
  });
}
