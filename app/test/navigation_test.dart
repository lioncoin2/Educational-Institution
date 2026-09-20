import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Walks the student journey by tapping, exactly as a reviewer would, and
/// asserts the router lands where it should at every step.
void main() {
  late ProviderContainer container;

  /// The deepest matched route. `currentConfiguration.uri` is NOT used here:
  /// for imperative pushes go_router leaves it on the base location, while
  /// the leaf match carries where the user actually is.
  String location() {
    final router = container.read(routerProvider);
    return router.routerDelegate.currentConfiguration.last.matchedLocation;
  }

  Future<void> boot(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    container = ProviderContainer();
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const QuranInstitutionApp(),
      ),
    );
    await tester.pump();
  }

  /// Scrolls the target into view before tapping, the way a person would.
  Future<void> tapAt(WidgetTester tester, Finder finder) async {
    final target = finder.first;
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    await tester.tap(target);
    await tester.pumpAndSettle();
  }

  Future<void> tapText(WidgetTester tester, String text) =>
      tapAt(tester, find.text(text));

  testWidgets('splash hands over to home on its own', (tester) async {
    await boot(tester);
    expect(location(), '/splash');

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(location(), '/home');
  });

  testWidgets('programs → details → levels → episode → lesson, and back',
      (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapText(tester, 'البرامج');
    expect(location(), '/programs');

    await tapText(tester, 'قسم تجويد متوسط');
    expect(location(), '/programs/dep-tajweed-2');

    await tapText(tester, 'عرض المسار والمستويات');
    expect(location(), '/programs/dep-tajweed-2/levels');

    await tapText(tester, 'الحلقة الخامسة');
    expect(location(), '/programs/dep-tajweed-2/levels/dep-tajweed-2-h5');

    // The episode's primary action opens the current lesson.
    await tapAt(tester, find.textContaining('تابعي:'));
    expect(location(), contains('/lessons/'));

    // Walk the stack back up. The router is read from the container, not from
    // a captured BuildContext — that element is deactivated by the first pop.
    for (final expected in [
      '/programs/dep-tajweed-2/levels/dep-tajweed-2-h5',
      '/programs/dep-tajweed-2/levels',
      '/programs/dep-tajweed-2',
      '/programs',
    ]) {
      container.read(routerProvider).pop();
      await tester.pumpAndSettle();
      expect(location(), expected);
    }
  });

  testWidgets('every bottom-navigation tab resolves', (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    for (final (label, path) in const [
      ('البرامج', '/programs'),
      ('مساري', '/path'),
      ('الشهادات', '/certificates'),
      ('حسابي', '/profile'),
      ('الرئيسية', '/home'),
    ]) {
      await tapText(tester, label);
      expect(location(), path, reason: 'التبويب «$label» لم يفتح $path');
    }
  });

  testWidgets('the ladder jumps into the levels of a department',
      (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapText(tester, 'مساري');
    expect(location(), '/path');

    await tapText(tester, 'قسم تجويد مبتدئ');
    expect(location(), '/programs/dep-tajweed-1/levels');
  });

  testWidgets('certificates open their detail view', (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapText(tester, 'الشهادات');
    expect(location(), '/certificates');

    await tapText(tester, 'إتمام قسم تجويد مبتدئ');
    expect(location(), '/certificates/c1');
  });

  testWidgets('profile reaches progress, notifications and announcements',
      (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapText(tester, 'حسابي');

    await tapText(tester, 'تقدّمي');
    expect(location(), '/progress');
    container.read(routerProvider).pop();
    await tester.pumpAndSettle();

    await tapText(tester, 'الإعلانات');
    expect(location(), '/announcements');
    container.read(routerProvider).pop();
    await tester.pumpAndSettle();

    await tapText(tester, 'الإشعارات');
    expect(location(), '/notifications');
  });

  testWidgets('marking notifications read clears the home badge',
      (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    expect(container.read(unreadNotificationCountProvider), 3);

    await tapAt(tester, find.byIcon(Icons.notifications_none_rounded));
    expect(location(), '/notifications');

    await tapAt(tester, find.byIcon(Icons.done_all_rounded));
    expect(container.read(unreadNotificationCountProvider), 0);
  });

  testWidgets('an unknown URL shows the not-found screen', (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    container.read(routerProvider).go('/programs/does-not-exist/levels/nope');
    await tester.pumpAndSettle();
    expect(find.textContaining('لم نجد هذه الحلقة'), findsOneWidget);
  });
}
