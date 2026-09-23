import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/features/notifications/state/notification_list_controller.dart';
import 'package:quran_institution_app/features/notifications/state/notification_preferences_controller.dart';
import 'package:quran_institution_app/features/notifications/state/push_registration.dart';
import 'package:quran_institution_app/features/notifications/state/unread_count_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'notification_test_support.dart';

void main() {
  late ScriptedNotifications repo;
  late FakeRealtimeClient realtime;
  late ProviderContainer container;

  ProviderContainer start({List<Override> extra = const []}) {
    container = ProviderContainer(
      overrides: [
        notificationsRepositoryProvider.overrideWithValue(repo),
        realtimeConnectionProvider.overrideWithValue(realtime),
        clockProvider.overrideWithValue(() => testNow),
        ...extra,
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  /// Lets every scheduled microtask and future settle.
  Future<void> settle() async {
    for (var i = 0; i < 10; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<NotificationListState> list() async {
    final subscription = container.listen(notificationListProvider, (_, _) {});
    addTearDown(subscription.close);
    return container.read(notificationListProvider.future);
  }

  /// The badge's count, listened to as the app's bell listens to it.
  Future<UnreadCount> counted() async {
    final subscription = container.listen(unreadCountProvider, (_, _) {});
    addTearDown(subscription.close);
    return container.read(unreadCountProvider.future);
  }

  NotificationListState shown() =>
      container.read(notificationListProvider).value!;
  UnreadCount? count() => container.read(unreadCountProvider).value;
  List<String> ids() => [for (final n in shown().items) n.id];

  setUp(() {
    repo = ScriptedNotifications();
    realtime = FakeRealtimeClient();
  });

  group('the list', () {
    test(
      'loads newest first, and appends the next page without repeating any',
      () async {
        for (var i = 1; i <= 25; i++) {
          repo.deliver(note('n$i', minutesAgo: 100 - i));
        }
        start();
        final first = await list();
        expect(first.items, hasLength(20));
        expect(first.items.first.id, 'n25');
        expect(first.hasMore, isTrue);

        await container.read(notificationListProvider.notifier).loadMore();
        expect(ids(), [for (var i = 25; i >= 1; i--) 'n$i']);
        expect(shown().hasMore, isFalse);
      },
    );

    test('a failed first load is an error with a way back', () async {
      repo.failList = 'network.unreachable';
      start();
      await expectLater(list(), throwsA(isA<NotificationsException>()));
      repo.failList = null;
      container.invalidate(notificationListProvider);
      expect((await list()).items, isEmpty);
    });

    test(
      'a failed next page keeps what is shown and offers another try',
      () async {
        for (var i = 1; i <= 25; i++) {
          repo.deliver(note('n$i', minutesAgo: 100 - i));
        }
        start();
        await list();
        repo.failList = 'network.unreachable';
        await container.read(notificationListProvider.notifier).loadMore();
        expect(shown().items, hasLength(20));
        expect(shown().loadMoreFailed, isTrue);
        repo.failList = null;
        await container.read(notificationListProvider.notifier).loadMore();
        expect(shown().items, hasLength(25));
      },
    );
  });

  group('live', () {
    test('a new notification goes to the top, and counts — once, however often it arrives', () async {
      repo.deliver(note('old', minutesAgo: 30));
      start();
      await list();
      await counted();
      expect(count(), const UnreadCount(1));

      final fresh = note('fresh');
      repo.deliver(fresh); // the server stored it…
      realtime.emit(created(fresh)); // …and says so
      realtime.emit(created(fresh)); // …twice (a redelivery)
      await settle();

      expect(ids(), ['fresh', 'old']);
      expect(count(), const UnreadCount(2));
    });

    test(
      'an older one arriving late takes its place in time, not the top',
      () async {
        repo.deliver(note('newest', minutesAgo: 1));
        start();
        await list();
        realtime.emit(created(note('older', minutesAgo: 60)));
        await settle();
        expect(ids(), ['newest', 'older']);
      },
    );

    test(
      'read on another device: shown read here, and the badge re-counted',
      () async {
        repo
          ..deliver(note('a', minutesAgo: 2))
          ..deliver(note('b', minutesAgo: 1));
        start();
        await list();
        await counted();
        final before = repo.countCalls;

        await repo.markRead('a');
        realtime.emit(
          NotificationReadEvent(
            eventId: 'notification.read:a',
            occurredAt: testNow,
            notificationId: 'a',
            readAt: testNow,
          ),
        );
        await settle();
        expect(shown().items.firstWhere((n) => n.id == 'a').isRead, isTrue);
        expect(repo.countCalls, greaterThan(before));
        expect(count(), const UnreadCount(1));

        await repo.markAllRead();
        realtime.emit(
          NotificationsReadAllEvent(
            eventId: 'notification.read_all:x',
            occurredAt: testNow,
            throughCreatedAt: testNow,
            readAt: testNow,
          ),
        );
        await settle();
        expect(shown().hasUnread, isFalse);
        expect(count(), UnreadCount.zero);
      },
    );

    test(
      'back online, the first page is fetched again and merged in',
      () async {
        repo.deliver(note('seen', minutesAgo: 10));
        start();
        await list();
        await counted();
        repo.deliver(note('missed', minutesAgo: 1)); // arrived while offline
        realtime.setStatus(RealtimeStatus.reconnected);
        await settle();
        expect(ids(), ['missed', 'seen']);
        expect(count(), const UnreadCount(2));
      },
    );
  });

  group('reading', () {
    test(
      'one: shown read at once, confirmed by the server, and the badge lowered',
      () async {
        repo
          ..deliver(note('a', minutesAgo: 2))
          ..deliver(note('b', minutesAgo: 1));
        start();
        await list();
        await counted();

        await container
            .read(notificationListProvider.notifier)
            .markRead(shown().items.last);
        await settle();
        expect(shown().items.last.isRead, isTrue);
        expect(repo.all.firstWhere((n) => n.id == 'a').isRead, isTrue);
        expect(count(), const UnreadCount(1));
      },
    );

    test(
      'one, refused: restored to unread, and the refusal reported',
      () async {
        repo.deliver(note('a'));
        start();
        await list();
        repo.failMarkRead = 'network.unreachable';
        await expectLater(
          container
              .read(notificationListProvider.notifier)
              .markRead(shown().items.single),
          throwsA(isA<NotificationsException>()),
        );
        expect(shown().items.single.isRead, isFalse);
      },
    );

    test(
      'all: up to the newest shown — never one that arrived since',
      () async {
        repo
          ..deliver(note('a', minutesAgo: 3))
          ..deliver(note('b', minutesAgo: 2));
        start();
        await list();
        await counted();
        repo.deliver(note('late', minutesAgo: 1)); // stored, not yet shown

        await container.read(notificationListProvider.notifier).markAllRead();
        await settle();
        expect(repo.markAllThrough, ['b']);
        expect(
          shown().items.where((n) => n.id != 'late').every((n) => n.isRead),
          isTrue,
        );
        expect(repo.all.firstWhere((n) => n.id == 'late').isRead, isFalse);
        expect(
          count(),
          const UnreadCount(1),
        ); // the server's word, after the optimistic zero
      },
    );

    test('all, refused: what it marked is restored', () async {
      repo
        ..deliver(note('a', minutesAgo: 3, read: true))
        ..deliver(note('b', minutesAgo: 2));
      start();
      await list();
      repo.failMarkAll = 'network.unreachable';
      await expectLater(
        container.read(notificationListProvider.notifier).markAllRead(),
        throwsA(isA<NotificationsException>()),
      );
      expect(
        {for (final n in shown().items) n.id: n.isRead},
        {'b': false, 'a': true},
      );
    });
  });

  group('the unread count', () {
    test('is the server’s, capped, and reads as "99+" past the cap', () async {
      for (var i = 0; i < 120; i++) {
        repo.deliver(note('n$i', minutesAgo: i));
      }
      start();
      expect(await counted(), const UnreadCount(99, capped: true));
      expect(container.read(unreadNotificationCountProvider), 100);
    });

    test('is zero, not an error, when nobody is signed in', () async {
      repo = _SignedOut();
      start();
      expect(await counted(), UnreadCount.zero);
      expect(container.read(unreadNotificationCountProvider), 0);
    });
  });

  group('preferences', () {
    test('turning push off keeps the center on, and stays off', () async {
      start();
      final subscription = container.listen(
        notificationPreferencesProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      await container.read(notificationPreferencesProvider.future);
      await container
          .read(notificationPreferencesProvider.notifier)
          .change('MESSAGES', push: false);
      final messages = container
          .read(notificationPreferencesProvider)
          .value!
          .single;
      expect(
        (messages.inApp, messages.realtime, messages.push),
        (true, true, false),
      );
      expect((await repo.preferences()).single.push, isFalse);
    });

    test('a refused change is undone and reported', () async {
      start();
      final subscription = container.listen(
        notificationPreferencesProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      await container.read(notificationPreferencesProvider.future);
      repo.failPreferences = 'network.unreachable';
      await expectLater(
        container
            .read(notificationPreferencesProvider.notifier)
            .change('MESSAGES', realtime: false),
        throwsA(isA<NotificationsException>()),
      );
      expect(
        container.read(notificationPreferencesProvider).value!.single.realtime,
        isTrue,
      );
    });
  });

  group('push registration', () {
    const signedIn = CurrentUser(
      id: 'u-1',
      displayName: 'طالب',
      status: AccountStatus.active,
      roles: ['STUDENT'],
      permissions: {'messaging.read'},
    );

    test('registers this device when someone is signed in and the platform has a token', () async {
      start(
        extra: [
          pushTokenSourceProvider.overrideWithValue(FakePushTokenSource()),
          sessionUserProvider.overrideWith((ref) async => signedIn),
        ],
      );
      await container.read(sessionUserProvider.future);
      final registration = container.read(pushRegistrationProvider);
      await settle();
      expect(repo.registeredTokens, ['fcm-test-token']);
      expect(registration.deviceId, isNotNull);

      await registration.release();
      expect(repo.unregistered, hasLength(1));
      expect(registration.deviceId, isNull);
    });

    test('registers nothing in this build — there is no push plugin', () async {
      start(extra: [sessionUserProvider.overrideWith((ref) async => signedIn)]);
      await container.read(sessionUserProvider.future);
      container.read(pushRegistrationProvider);
      await settle();
      expect(repo.registeredTokens, isEmpty);
    });
  });
}

/// An inbox that answers "sign in first" to everything.
class _SignedOut extends ScriptedNotifications {
  @override
  Future<UnreadCount> unreadCount() async => throw const NotificationsException(
    'identity.authentication_required',
    'Authentication required.',
  );
}
