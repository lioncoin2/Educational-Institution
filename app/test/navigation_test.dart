import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/features/notifications/state/unread_count_controller.dart';

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
  ///
  /// Slivers below the fold are not built until they scroll into range, so
  /// ensureVisible alone cannot reach them — it needs an existing element.
  /// Anything not yet in the tree is scrolled to first.
  Future<void> tapAt(WidgetTester tester, Finder finder) async {
    if (finder.evaluate().isEmpty) {
      final scrollable = find.byType(Scrollable);
      if (scrollable.evaluate().isNotEmpty) {
        await tester.scrollUntilVisible(
          finder,
          300,
          scrollable: scrollable.first,
        );
        await tester.pumpAndSettle();
      }
    }
    final target = finder.first;
    await tester.ensureVisible(target);
    await tester.pumpAndSettle();
    await tester.tap(target);
    await tester.pumpAndSettle();
  }

  Future<void> tapText(WidgetTester tester, String text) =>
      tapAt(tester, find.text(text));

  /// Taps a bottom-navigation destination specifically. Screen content can
  /// repeat a tab's label — /path renders the word "مساري" as its heading as
  /// well — so nav taps are scoped to the NavigationBar.
  Future<void> tapNav(WidgetTester tester, String label) => tapAt(
    tester,
    find.descendant(of: find.byType(NavigationBar), matching: find.text(label)),
  );

  testWidgets('splash hands over to home on its own', (tester) async {
    await boot(tester);
    expect(location(), '/splash');

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(location(), '/home');
  });

  testWidgets('programs → details → levels → episode → lesson, and back', (
    tester,
  ) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapText(tester, 'البرامج');
    expect(location(), '/programs');

    // The Programs grid shows study fields; each opens a representative program.
    // "التجويد والقراءات" opens the intermediate tajweed department.
    await tapText(tester, 'التجويد والقراءات');
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
      ('المجتمعات', '/communities'),
      ('الرسائل', '/messages'),
      ('حسابي', '/profile'),
      ('الرئيسية', '/home'),
    ]) {
      await tapNav(tester, label);
      expect(location(), path, reason: 'التبويب «$label» لم يفتح $path');
    }
  });

  testWidgets('the five bottom-navigation destinations are in the agreed '
      'right-to-left order', (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    // The order the labels occur in the tree is the RTL on-screen order: in an
    // RTL directionality the NavigationBar lays its destinations out right to
    // left, so the first destination ('الرئيسية') sits on the right.
    final labels = find
        .descendant(of: find.byType(NavigationBar), matching: find.byType(Text))
        .evaluate()
        .map((e) => (e.widget as Text).data)
        .toList();
    expect(labels, ['الرئيسية', 'البرامج', 'المجتمعات', 'الرسائل', 'حسابي']);
  });

  testWidgets('the ladder jumps into the levels of a department', (
    tester,
  ) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    // مساري left the bottom bar; it is reached from حسابي now.
    await tapNav(tester, 'حسابي');
    await tapText(tester, 'مساري التعليمي');
    expect(location(), '/path');

    await tapText(tester, 'قسم تجويد مبتدئ');
    expect(location(), '/programs/dep-tajweed-1/levels');
  });

  testWidgets('certificates open their detail view', (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    // الشهادات left the bottom bar; it is reached from حسابي now.
    await tapNav(tester, 'حسابي');
    await tapText(tester, 'الشهادات والإجازات');
    expect(location(), '/certificates');

    await tapText(tester, 'إتمام قسم تجويد مبتدئ');
    expect(location(), '/certificates/c1');
  });

  testWidgets('حسابي reaches مساري and الشهادات, and Back returns to حسابي', (
    tester,
  ) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapNav(tester, 'حسابي');

    await tapText(tester, 'مساري التعليمي');
    expect(location(), '/path');
    container.read(routerProvider).pop();
    await tester.pumpAndSettle();
    expect(location(), '/profile');

    await tapText(tester, 'الشهادات والإجازات');
    expect(location(), '/certificates');
    container.read(routerProvider).pop();
    await tester.pumpAndSettle();
    expect(location(), '/profile');
  });

  testWidgets('profile reaches progress, notifications and announcements', (
    tester,
  ) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapNav(tester, 'حسابي');

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

  testWidgets('the المجتمعات tab opens a community’s conversation, its page from the header', (
    tester,
  ) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapNav(tester, 'المجتمعات');
    expect(location(), '/communities');

    // Tapping a community opens its primary view — the conversation — directly.
    await tapText(tester, 'مجتمع طلاب التجويد');
    expect(location(), '/messages/mock-community-tajweed-chat');

    // Its page (settings/overview) is an explicit step from the chat header.
    await tester.tap(find.byKey(const Key('conversation-community-header')));
    await tester.pumpAndSettle();
    expect(location(), '/communities/mock-community-tajweed');

    container.read(routerProvider).pop();
    await tester.pumpAndSettle();
    expect(location(), '/messages/mock-community-tajweed-chat');
  });

  testWidgets('a community’s owner reaches its invitation links, and back', (
    tester,
  ) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    await tapNav(tester, 'المجتمعات');
    await tapText(tester, 'مجتمع أسرة الحفظ');
    // The row opens the conversation; its page is reached from the header.
    expect(location(), '/messages/mock-community-family-chat');
    await tester.tap(find.byKey(const Key('conversation-community-header')));
    await tester.pumpAndSettle();
    expect(location(), '/communities/mock-community-family');

    await tapText(tester, 'روابط الدعوة');
    expect(location(), '/communities/mock-community-family/invitations');

    container.read(routerProvider).pop();
    await tester.pumpAndSettle();
    expect(location(), '/communities/mock-community-family');
  });

  testWidgets('an invitation link lands on /invite, which leads on to the '
      'communities', (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    // The token never reaches the router: the route is bare.
    container.read(routerProvider).go('/invite');
    await tester.pumpAndSettle();
    expect(location(), '/invite');
    expect(find.text('لا توجد دعوة لفتحها.'), findsOneWidget);

    await tapText(tester, 'الذهاب إلى مجتمعاتي');
    expect(location(), '/communities');
  });

  testWidgets('marking notifications read clears the home badge', (
    tester,
  ) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    expect(container.read(unreadNotificationCountProvider), 3);

    await tapAt(tester, find.byIcon(Icons.notifications_none_rounded));
    expect(location(), '/notifications');

    await tapAt(tester, find.byIcon(Icons.done_all_rounded));
    expect(container.read(unreadNotificationCountProvider), 0);
  });

  // A real route with an id that names nothing: the screen's own empty state.
  testWidgets('a missing halaqa under a real route shows the episode\'s '
      'not-found state', (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    container.read(routerProvider).go('/programs/does-not-exist/levels/nope');
    await tester.pumpAndSettle();
    expect(find.textContaining('لم نجد هذه الحلقة'), findsOneWidget);
    expect(find.text('صفحة غير موجودة'), findsNothing);
  });

  // No route at all: the router's own not-found screen, naming the path, with
  // the way home.
  testWidgets('an unknown URL shows the not-found screen', (tester) async {
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    container.read(routerProvider).go('/no-such-screen');
    await tester.pumpAndSettle();
    expect(find.text('صفحة غير موجودة'), findsOneWidget);
    expect(find.textContaining('/no-such-screen'), findsOneWidget);

    await tester.tap(find.text('العودة إلى الرئيسية'));
    await tester.pumpAndSettle();
    expect(location(), '/home');
  });

  // The web root can arrive with a tracking query (…/?utm_source=…) or a
  // fragment. go_router substitutes `initialLocation` only for an initial route
  // that is exactly '/', so without a root redirect such an entry falls through
  // to the not-found screen. These assert the observable route result.

  testWidgets('the root opened with a tracking query reaches the app, not the '
      'not-found screen', (tester) async {
    tester.platformDispatcher.defaultRouteNameTestValue = '/?utm_source=share';
    addTearDown(tester.platformDispatcher.clearDefaultRouteNameTestValue);
    await boot(tester);

    // A root entry — whatever query rides on it — takes the splash, as a bare
    // '/' does; it never shows the router's not-found screen.
    expect(find.text('صفحة غير موجودة'), findsNothing);
    expect(location(), '/splash');

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(location(), '/home');
  });

  testWidgets('the root opened with several tracking parameters still reaches '
      'the app', (tester) async {
    tester.platformDispatcher.defaultRouteNameTestValue =
        '/?fbclid=example&utm_campaign=test';
    addTearDown(tester.platformDispatcher.clearDefaultRouteNameTestValue);
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    expect(find.text('صفحة غير موجودة'), findsNothing);
    expect(location(), '/home');
  });

  testWidgets('the root opened from a shared link with a query and a fragment '
      'still reaches the app', (tester) async {
    tester.platformDispatcher.defaultRouteNameTestValue =
        '/?utm_source=share#section';
    addTearDown(tester.platformDispatcher.clearDefaultRouteNameTestValue);
    await boot(tester);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    expect(find.text('صفحة غير موجودة'), findsNothing);
    expect(location(), '/home');
  });

  testWidgets('a deep link that carries its own query is left alone, not swept '
      'to the splash', (tester) async {
    tester.platformDispatcher.defaultRouteNameTestValue = '/home?source=share';
    addTearDown(tester.platformDispatcher.clearDefaultRouteNameTestValue);
    await boot(tester);

    // Its path is not the root, so the root redirect does not touch it: the app
    // opens straight on /home, not the splash.
    expect(location(), '/home');

    // Let HomeScreen's one-shot entrance timers fire before teardown.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(location(), '/home');
  });
}
