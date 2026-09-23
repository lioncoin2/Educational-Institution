import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/widgets/foundations/unread_badge.dart';
import 'package:quran_institution_app/core/widgets/patterns/notification_tile.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/notifications/state/unread_count_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'notification_test_support.dart';

void main() {
  late ScriptedNotifications repo;
  late FakeRealtimeClient realtime;
  late ProviderContainer container;

  Future<void> open(
    WidgetTester tester,
    String location, {
    List<Override> extra = const [],
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    container = ProviderContainer(
      overrides: [
        notificationsRepositoryProvider.overrideWithValue(repo),
        messagingRepositoryProvider.overrideWithValue(
          MockMessagingRepository(latency: Duration.zero),
        ),
        realtimeConnectionProvider.overrideWithValue(realtime),
        clockProvider.overrideWithValue(() => testNow),
        ...extra,
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const QuranInstitutionApp(),
      ),
    );
    await tester.pump(const Duration(seconds: 3)); // the splash timer
    await tester.pumpAndSettle();
    container.read(routerProvider).go(location);
    await tester.pumpAndSettle();
  }

  /// The deepest matched route — for an imperative push, go_router leaves
  /// `currentConfiguration.uri` on the base location (see navigation_test).
  String location() => container
      .read(routerProvider)
      .routerDelegate
      .currentConfiguration
      .last
      .matchedLocation;

  setUp(() {
    repo = ScriptedNotifications();
    realtime = FakeRealtimeClient();
  });

  group('the badge', () {
    Future<void> badge(WidgetTester tester, int count) => tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(child: UnreadBadge(count: count)),
        ),
      ),
    );

    testWidgets('shows nothing at 0', (tester) async {
      await badge(tester, 0);
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('shows the number from 1 to 99', (tester) async {
      await badge(tester, 1);
      expect(find.text('1'), findsOneWidget);
      await badge(tester, 99);
      expect(find.text('99'), findsOneWidget);
    });

    testWidgets('shows 99+ from 100', (tester) async {
      await badge(tester, 100);
      expect(find.text('99+'), findsOneWidget);
      await badge(tester, 4000);
      expect(find.text('99+'), findsOneWidget);
    });
  });

  group('the notification center', () {
    testWidgets(
      'lists what each notification says — in Arabic, newest first, unread marked',
      (tester) async {
        repo
          ..deliver(note('older', minutesAgo: 120, read: true, sender: 'يوسف'))
          ..deliver(note('newer', minutesAgo: 5));
        await open(tester, '/notifications');

        expect(find.text('الإشعارات'), findsOneWidget);
        expect(
          find.text('لديك رسالة جديدة من الأستاذ عبدالله.'),
          findsOneWidget,
        );
        expect(find.text('لديك رسالة جديدة من يوسف.'), findsOneWidget);
        expect(find.text('قبل 5 دقائق'), findsOneWidget);
        expect(find.text('قبل ساعتين'), findsOneWidget);
        // One unread: one dot.
        expect(find.byKey(const ValueKey('unread-dot')), findsOneWidget);
        final tiles = tester.widgetList<NotificationTile>(
          find.byType(NotificationTile),
        );
        expect(tiles.map((t) => t.isRead), [false, true]);
        // Demo build: says it is demo data.
        expect(find.textContaining('إشعارات تجريبية'), findsOneWidget);
      },
    );

    testWidgets('opening one marks it read and goes to its conversation', (
      tester,
    ) async {
      repo.deliver(note('n1', conversationId: 'mock-direct'));
      await open(tester, '/notifications');
      await tester.tap(find.text('لديك رسالة جديدة من الأستاذ عبدالله.'));
      await tester.pumpAndSettle();
      expect(location(), '/messages/mock-direct');
      expect(repo.all.single.isRead, isTrue);
      expect(container.read(unreadNotificationCountProvider), 0);
    });

    testWidgets(
      'a notification whose conversation is gone says so — and goes nowhere',
      (tester) async {
        repo.deliver(note('stale', conversationId: 'mock-archived'));
        await open(tester, '/notifications');
        await tester.tap(find.text('لديك رسالة جديدة من الأستاذ عبدالله.'));
        await tester.pumpAndSettle();
        expect(find.text('هذا المحتوى لم يعد متاحًا.'), findsOneWidget);
        expect(location(), '/notifications');
        expect(repo.all.single.isRead, isTrue);
      },
    );

    testWidgets(
      'one from a newer server, of a kind this app cannot open, degrades safely',
      (tester) async {
        repo.deliver(
          AppNotification(
            id: 'future',
            type: NotificationType.unknown,
            titleKey: 'notification.prayer_time.title',
            bodyKey: 'notification.prayer_time.body',
            params: const {},
            target: const UnsupportedTarget('prayer_time'),
            createdAt: testNow,
          ),
        );
        await open(tester, '/notifications');
        expect(find.text('إشعار جديد'), findsOneWidget);
        expect(find.text('لديك إشعار جديد.'), findsOneWidget);
        await tester.tap(find.text('إشعار جديد'));
        await tester.pumpAndSettle();
        expect(
          find.text('لا يمكن فتح هذا الإشعار في هذا الإصدار من التطبيق.'),
          findsOneWidget,
        );
        expect(location(), '/notifications');
      },
    );

    testWidgets('an empty inbox says so', (tester) async {
      await open(tester, '/notifications');
      expect(find.text('لا توجد إشعارات'), findsOneWidget);
    });

    testWidgets('a failure shows an error with a retry that recovers', (
      tester,
    ) async {
      repo
        ..deliver(note('n1'))
        ..failList = 'network.unreachable';
      await open(tester, '/notifications');
      expect(find.text('تعذّر عرض المحتوى'), findsOneWidget);
      repo.failList = null;
      await tester.tap(find.text('إعادة المحاولة'));
      await tester.pumpAndSettle();
      expect(find.text('لديك رسالة جديدة من الأستاذ عبدالله.'), findsOneWidget);
    });

    testWidgets('a notification arriving live appears at the top, once', (
      tester,
    ) async {
      repo.deliver(note('old', minutesAgo: 30, sender: 'يوسف'));
      await open(tester, '/notifications');
      final fresh = note('fresh', sender: 'أحمد');
      repo.deliver(fresh);
      realtime
        ..emit(created(fresh))
        ..emit(created(fresh));
      await tester.pumpAndSettle();
      expect(find.text('لديك رسالة جديدة من أحمد.'), findsOneWidget);
      final tiles = tester.widgetList<NotificationTile>(
        find.byType(NotificationTile),
      );
      expect(tiles.first.body, 'لديك رسالة جديدة من أحمد.');
    });

    testWidgets('"mark all as read" clears every unread mark and the badge', (
      tester,
    ) async {
      repo
        ..deliver(note('a', minutesAgo: 2))
        ..deliver(note('b', minutesAgo: 1));
      await open(tester, '/notifications');
      expect(container.read(unreadNotificationCountProvider), 2);
      await tester.tap(find.byIcon(Icons.done_all_rounded));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('unread-dot')), findsNothing);
      expect(container.read(unreadNotificationCountProvider), 0);
      expect(find.byIcon(Icons.done_all_rounded), findsNothing);
    });
  });

  group('settings', () {
    testWidgets(
      'three separate switches — and turning one off leaves the others',
      (tester) async {
        await open(tester, '/notifications/settings');
        expect(find.text('إعدادات الإشعارات'), findsOneWidget);
        expect(find.text('الرسائل'), findsOneWidget);
        // No push plugin in this build: the screen says so.
        expect(find.textContaining('غير مفعّلة في هذه النسخة'), findsOneWidget);

        await tester.tap(find.text('على الجهاز'));
        await tester.pumpAndSettle();
        final stored = (await repo.preferences()).single;
        expect(
          (stored.inApp, stored.realtime, stored.push),
          (true, true, false),
        );

        await tester.tap(find.text('داخل التطبيق'));
        await tester.pumpAndSettle();
        expect((await repo.preferences()).single.inApp, isFalse);
        // Nothing is kept, so nothing is delivered: said, and the others wait.
        expect(find.textContaining('لا يُحفظ الإشعار'), findsOneWidget);
        final switches = tester
            .widgetList<SwitchListTile>(find.byType(SwitchListTile))
            .toList();
        expect(switches[1].onChanged, isNull);
        expect(switches[2].onChanged, isNull);
      },
    );

    testWidgets('a change the server refuses is undone, and said', (
      tester,
    ) async {
      repo.failPreferences = 'network.unreachable';
      await open(tester, '/notifications/settings');
      await tester.tap(find.text('فورًا أثناء استخدام التطبيق'));
      await tester.pumpAndSettle();
      expect(find.text('تعذّر حفظ الإعداد. حاول مرة أخرى.'), findsOneWidget);
      final realtimeSwitch = tester
          .widgetList<SwitchListTile>(find.byType(SwitchListTile))
          .toList()[1];
      expect(realtimeSwitch.value, isTrue);
    });

    testWidgets('are reached from the center', (tester) async {
      await open(tester, '/notifications');
      await tester.tap(find.byIcon(Icons.tune_rounded));
      await tester.pumpAndSettle();
      expect(location(), '/notifications/settings');
    });
  });

  group('one unread count, everywhere', () {
    testWidgets('the home bell and the profile row show the same number', (
      tester,
    ) async {
      for (var i = 0; i < 3; i++) {
        repo.deliver(note('n$i', minutesAgo: i));
      }
      await open(tester, '/home');
      expect(
        find.descendant(of: find.byType(UnreadBadge), matching: find.text('3')),
        findsOneWidget,
      );
      container.read(routerProvider).go('/profile');
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: find.byType(UnreadBadge), matching: find.text('3')),
        findsOneWidget,
      );
    });

    testWidgets('past 99 the bell says 99+', (tester) async {
      for (var i = 0; i < 150; i++) {
        repo.deliver(note('n$i', minutesAgo: i));
      }
      await open(tester, '/home');
      expect(
        find.descendant(
          of: find.byType(UnreadBadge),
          matching: find.text('99+'),
        ),
        findsOneWidget,
      );
    });
  });
}
