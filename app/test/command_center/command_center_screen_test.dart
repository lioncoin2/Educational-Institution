import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/core/widgets/foundations/async_view.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/data/models/command_center.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/command_center/command_center_copy.dart';
import 'package:quran_institution_app/features/command_center/command_center_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

class _FakeReporting implements ReportingRepository {
  _FakeReporting(this._answer);
  final Future<CommandCenter> Function() _answer;
  @override
  Future<CommandCenter> commandCenter() => _answer();
}

CommandCenter _center({
  DataOrigin origin = DataOrigin.records,
  List<CommandWidget>? widgets,
}) => CommandCenter(
  origin: origin,
  widgets: widgets ??
      const [
        CommandWidget(
          id: 'academic.structure',
          category: 'today',
          title: 'الهيكل الأكاديمي',
          metrics: [
            CommandMetric(key: 'halaqat_active', label: 'الحلقات المُفعّلة', value: 45),
          ],
        ),
      ],
);

Future<void> pump(WidgetTester tester, ReportingRepository repo) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        reportingRepositoryProvider.overrideWithValue(repo),
        sessionUserProvider.overrideWith((ref) async => null),
      ],
      child: MaterialApp(
        home: const CommandCenterScreen(),
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
      ),
    ),
  );
}

void main() {
  testWidgets('skeleton while loading, then the widgets with their facts', (tester) async {
    final hold = Completer<CommandCenter>();
    await pump(tester, _FakeReporting(() => hold.future));
    await tester.pump();
    expect(find.byType(SkeletonBox), findsWidgets);

    hold.complete(_center());
    await tester.pumpAndSettle();
    expect(find.text(CommandCenterCopy.category('today')), findsOneWidget);
    expect(find.text('الهيكل الأكاديمي'), findsOneWidget);
    expect(find.text('الحلقات المُفعّلة'), findsOneWidget);
    expect(find.text('45'), findsOneWidget);
  });

  testWidgets('an empty center shows the empty state, not an error', (tester) async {
    await pump(tester, _FakeReporting(() async => _center(widgets: const [])));
    await tester.pumpAndSettle();
    expect(find.text(CommandCenterCopy.empty), findsOneWidget);
  });

  testWidgets('a refusal is said through the server code, with a retry', (tester) async {
    await pump(
      tester,
      _FakeReporting(
        () async => throw const ReportingException('identity.permission_denied', 'no'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(CommandCenterCopy.error('identity.permission_denied')), findsOneWidget);
    expect(find.text(CommandCenterCopy.retry), findsOneWidget);
  });

  testWidgets('a demo center is flagged as mock data', (tester) async {
    await pump(tester, _FakeReporting(() async => _center(origin: DataOrigin.mock)));
    await tester.pumpAndSettle();
    expect(find.byType(MockBanner), findsOneWidget);
  });

  testWidgets('a widget with no metric says so plainly, never a fabricated zero', (tester) async {
    await pump(
      tester,
      _FakeReporting(
        () async => _center(
          widgets: const [
            CommandWidget(id: 'x', category: 'today', title: 'ملخّص بلا بيانات', metrics: []),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('ملخّص بلا بيانات'), findsOneWidget);
    expect(find.text(CommandCenterCopy.noData), findsOneWidget);
  });
}
