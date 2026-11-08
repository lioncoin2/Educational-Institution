import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/push/push_seams.dart';
import 'package:quran_institution_app/features/notifications/notification_copy.dart';
import 'package:quran_institution_app/features/notifications/notification_target_resolver.dart';
import 'package:quran_institution_app/features/notifications/push_host.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'notification_test_support.dart';

const _ali = CurrentUser(
  id: 'u-ali',
  displayName: 'علي',
  status: AccountStatus.active,
  roles: ['STUDENT'],
  permissions: {'messaging.read'},
);

/// Every target opens its conversation page — the owning module agrees.
class _OpensConversations implements NotificationTargetResolver {
  @override
  Future<TargetResolution> resolve(NotificationTarget target) async =>
      switch (target) {
        ConversationTarget(:final conversationId) => OpenRoute(
          '/messages/$conversationId',
        ),
        _ => const CannotOpen('no'),
      };
}

void main() {
  late FakePushTokenSource source;
  late ScriptedNotifications repo;

  Future<GoRouter> pumpHost(
    WidgetTester tester, {
    PushTokenSource? push,
  }) async {
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (_, _) => const Scaffold(body: Text('home')),
        ),
        GoRoute(
          path: '/messages/:id',
          builder: (_, state) => Scaffold(
            body: Text('conversation ${state.pathParameters['id']}'),
          ),
        ),
        GoRoute(
          path: '/notifications',
          builder: (_, _) => const Scaffold(body: Text('inbox')),
        ),
      ],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          pushTokenSourceProvider.overrideWithValue(push ?? source),
          notificationsRepositoryProvider.overrideWithValue(repo),
          sessionUserProvider.overrideWith((ref) async => _ali),
          realtimeConnectionProvider.overrideWithValue(FakeRealtimeClient()),
          notificationTargetResolverProvider.overrideWithValue(
            _OpensConversations(),
          ),
        ],
        child: MaterialApp.router(
          routerConfig: router,
          builder: (context, child) => PushHost(router: router, child: child!),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return router;
  }

  setUp(() {
    source = FakePushTokenSource();
    repo = ScriptedNotifications();
  });

  testWidgets('opens what a tapped notification points at — once', (
    tester,
  ) async {
    repo.deliver(note('n-1', conversationId: 'c-7'));
    await pumpHost(tester);
    source.tap(
      const PushTap(notificationId: 'n-1', target: ConversationTarget('c-7')),
    );
    await tester.pumpAndSettle();
    expect(find.text('conversation c-7'), findsOneWidget);
    expect(repo.all.single.isRead, isTrue);

    source.tap(
      const PushTap(notificationId: 'n-1', target: ConversationTarget('c-7')),
    );
    await tester.pumpAndSettle();
    expect(find.text('conversation c-7'), findsOneWidget); // not opened twice
  });

  testWidgets(
    'opens the notification that started the app, once someone is signed in',
    (tester) async {
      repo.deliver(note('n-2', conversationId: 'c-9'));
      source.startedBy = const PushTap(
        notificationId: 'n-2',
        target: ConversationTarget('c-9'),
      );
      await pumpHost(tester);
      expect(find.text('conversation c-9'), findsOneWidget);
    },
  );

  testWidgets(
    'makes its offer once, and asks the system only when the person says yes',
    (tester) async {
      source.permissionNow = PushPermission.notDetermined;
      await pumpHost(tester);
      expect(find.text(NotificationCopy.pushOfferTitle), findsOneWidget);
      expect(source.requests, 0);

      await tester.tap(find.text(NotificationCopy.pushEnable));
      await tester.pumpAndSettle();
      expect(source.requests, 1);
      expect(source.offered, isTrue);
      expect(find.text(NotificationCopy.pushOfferTitle), findsNothing);
      expect(repo.registeredTokens, ['fcm-test-token']);
    },
  );

  testWidgets(
    '"not now" closes the offer for good — the system is never asked',
    (tester) async {
      source.permissionNow = PushPermission.notDetermined;
      await pumpHost(tester);
      await tester.tap(find.text(NotificationCopy.pushLater));
      await tester.pumpAndSettle();
      expect(find.text(NotificationCopy.pushOfferTitle), findsNothing);
      expect(source.requests, 0);
      expect(source.offered, isTrue);
    },
  );

  testWidgets('adds nothing at all in a build without push', (tester) async {
    await pumpHost(tester, push: const UnavailablePushTokenSource());
    expect(find.text('home'), findsOneWidget);
    expect(find.text(NotificationCopy.pushOfferTitle), findsNothing);
    expect(find.byType(Column), findsNothing);
  });
}
