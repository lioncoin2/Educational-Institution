import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/features/notifications/notification_copy.dart';

/// A notification exactly as `GET /notifications` renders one.
Map<String, Object?> notificationJson({
  String id = 'n-1',
  String type = 'MESSAGE_RECEIVED',
  String titleKey = 'notification.message_received.title',
  String bodyKey = 'notification.message_received.body',
  Object? params = const {
    'senderDisplayName': 'الأستاذ عبدالله',
    'messageType': 'TEXT',
    'conversationType': 'GROUP',
  },
  Object? target = const {'kind': 'conversation', 'conversationId': 'c-1'},
  String createdAt = '2026-09-01T08:00:00.000Z',
  String? readAt,
}) => {
  'id': id,
  'type': type,
  'category': 'MESSAGES',
  'titleKey': titleKey,
  'bodyKey': bodyKey,
  'params': params,
  'target': target,
  'createdAt': createdAt,
  'readAt': readAt,
};

AppNotification parse(Map<String, Object?> json) =>
    AppNotification.fromJson(json);

void main() {
  group('a notification', () {
    test('parses the backend contract exactly', () {
      final n = parse(notificationJson());
      expect(n.id, 'n-1');
      expect(n.type, NotificationType.messageReceived);
      expect(n.titleKey, 'notification.message_received.title');
      expect(n.params['senderDisplayName'], 'الأستاذ عبدالله');
      expect(n.target, const ConversationTarget('c-1'));
      expect(n.createdAt, DateTime.utc(2026, 9, 1, 8));
      expect(n.isRead, isFalse);
      expect(
        parse(notificationJson(readAt: '2026-09-01T09:00:00.000Z')).isRead,
        isTrue,
      );
    });

    test('keeps a type this version does not know, as unknown', () {
      final n = parse(
        notificationJson(
          type: 'PRAYER_TIME_REMINDER',
          titleKey: 'notification.prayer_time_reminder.title',
          bodyKey: 'notification.prayer_time_reminder.body',
        ),
      );
      expect(n.type, NotificationType.unknown);
      // …and says something sensible about it, never a raw key.
      expect(NotificationCopy.title(n), 'إشعار جديد');
      expect(NotificationCopy.body(n), 'لديك إشعار جديد.');
    });

    test('keeps a target it cannot open as unsupported — never throws', () {
      expect(
        parse(
          notificationJson(target: {'kind': 'live_room', 'liveSessionId': 'l'}),
        ).target,
        isA<UnsupportedTarget>().having((t) => t.kind, 'kind', 'live_room'),
      );
      for (final broken in [
        null,
        'conversation:c-1',
        {'kind': 'conversation'},
        {'kind': 'conversation', 'conversationId': '../../admin'},
        {'kind': 42},
      ]) {
        expect(
          parse(notificationJson(target: broken)).target,
          isA<UnsupportedTarget>(),
        );
      }
    });

    test('keeps plain parameters only — nothing it could be tricked into interpreting', () {
      final n = parse(
        notificationJson(
          params: {
            'name': 'أحمد',
            'count': 3,
            'urgent': true,
            'nested': {'a': 1},
            'list': [1, 2],
            'nothing': null,
          },
        ),
      );
      expect(n.params, {'name': 'أحمد', 'count': 3, 'urgent': true});
      expect(parse(notificationJson(params: 'not a map')).params, isEmpty);
    });

    test('refuses what cannot be identified or dated; a page skips it', () {
      expect(() => parse({'type': 'MESSAGE_RECEIVED'}), throwsFormatException);
      expect(
        () => parse(notificationJson(createdAt: 'yesterday')),
        throwsFormatException,
      );
      final page = NotificationPage.fromJson({
        'items': [
          notificationJson(id: 'good'),
          {'id': 'broken'},
          'not even an object',
        ],
        'nextCursor': 'next',
      });
      expect(page.items.map((n) => n.id), ['good']);
      expect(page.nextCursor, 'next');
    });

    test('orders newest first, ties by id — as the server does', () {
      final a = parse(
        notificationJson(id: 'a', createdAt: '2026-09-01T08:00:00Z'),
      );
      final b = parse(
        notificationJson(id: 'b', createdAt: '2026-09-01T08:00:00Z'),
      );
      final c = parse(
        notificationJson(id: 'c', createdAt: '2026-09-01T09:00:00Z'),
      );
      expect(([a, b, c]..sort(AppNotification.newestFirst)).map((n) => n.id), [
        'c',
        'b',
        'a',
      ]);
      expect(b.isThrough(DateTime.utc(2026, 9, 1, 8), 'a'), isFalse);
      expect(a.isThrough(DateTime.utc(2026, 9, 1, 8), 'a'), isTrue);
      expect(c.isThrough(DateTime.utc(2026, 9, 1, 8), null), isFalse);
    });
  });

  group('the unread count', () {
    test('parses, and reads as a badge: capped means "more than 99"', () {
      expect(
        UnreadCount.fromJson({'count': 42, 'capped': false}),
        const UnreadCount(42),
      );
      final capped = UnreadCount.fromJson({'count': 99, 'capped': true});
      expect(capped.badgeValue, 100);
      expect(const UnreadCount(99).badgeValue, 99);
    });

    test('moves by one, never below zero, and never guesses below a cap', () {
      expect(const UnreadCount(98).plus(1), const UnreadCount(99));
      expect(
        const UnreadCount(99).plus(1),
        const UnreadCount(99, capped: true),
      );
      expect(
        const UnreadCount(99, capped: true).plus(1),
        const UnreadCount(99, capped: true),
      );
      expect(UnreadCount.zero.plus(-1), UnreadCount.zero);
    });
  });

  test('preferences parse per category', () {
    expect(
      ChannelPreferences.listFromJson({
        'categories': [
          {
            'category': 'MESSAGES',
            'inApp': true,
            'realtime': false,
            'push': true,
          },
        ],
      }),
      [
        const ChannelPreferences(
          category: 'MESSAGES',
          inApp: true,
          realtime: false,
          push: true,
        ),
      ],
    );
  });

  group('live frames', () {
    String frame(Map<String, Object?> body) =>
        jsonEncode({...body, 'version': 1});

    test('reads a new notification exactly as the inbox renders it', () {
      final parsed = ServerFrame.parse(
        frame({
          'type': 'notification.created',
          'eventId': 'notification.created:n-1',
          'occurredAt': '2026-09-01T08:00:00.000Z',
          'notification': notificationJson(),
        }),
      );
      expect(
        parsed,
        isA<NotificationCreatedEvent>()
            .having((e) => e.notification.id, 'id', 'n-1')
            .having((e) => e.eventId, 'eventId', 'notification.created:n-1'),
      );
    });

    test('reads "one was read" and "all up to here were read"', () {
      expect(
        ServerFrame.parse(
          frame({
            'type': 'notification.read',
            'eventId': 'notification.read:n-1',
            'occurredAt': '2026-09-01T09:00:00.000Z',
            'notificationId': 'n-1',
            'readAt': '2026-09-01T09:00:00.000Z',
          }),
        ),
        isA<NotificationReadEvent>().having(
          (e) => e.notificationId,
          'id',
          'n-1',
        ),
      );
      expect(
        ServerFrame.parse(
          frame({
            'type': 'notification.read_all',
            'eventId': 'notification.read_all:x',
            'occurredAt': '2026-09-01T09:00:00.000Z',
            'throughCreatedAt': '2026-09-01T08:00:00.000Z',
            'throughId': null,
            'readAt': '2026-09-01T09:00:00.000Z',
          }),
        ),
        isA<NotificationsReadAllEvent>().having(
          (e) => e.throughId,
          'through',
          isNull,
        ),
      );
    });

    test(
      'drops a notification frame it cannot read, instead of half-applying it',
      () {
        expect(
          ServerFrame.parse(
            frame({
              'type': 'notification.created',
              'eventId': 'x',
              'occurredAt': '2026-09-01T08:00:00.000Z',
              'notification': {'type': 'MESSAGE_RECEIVED'},
            }),
          ),
          isNull,
        );
        expect(ServerFrame.parse(frame({'type': 'notification.read'})), isNull);
      },
    );
  });

  group('what notifications say', () {
    AppNotification with_(Map<String, Object?> params) =>
        parse(notificationJson(params: params));

    test('a message: who sent it, and what kind — never what it said', () {
      final text = with_({'senderDisplayName': 'أحمد', 'messageType': 'TEXT'});
      expect(NotificationCopy.title(text), 'رسالة جديدة');
      expect(NotificationCopy.body(text), 'لديك رسالة جديدة من أحمد.');
      expect(
        NotificationCopy.title(with_({'messageType': 'VOICE'})),
        'رسالة صوتية جديدة',
      );
      expect(
        NotificationCopy.title(with_({'messageType': 'IMAGE'})),
        'صورة جديدة',
      );
      expect(NotificationCopy.body(with_({})), 'لديك رسالة جديدة.');
    });

    test('a new conversation and being added, by who did it and what kind', () {
      AppNotification created(Map<String, Object?> params) => parse(
        notificationJson(
          type: 'CONVERSATION_CREATED',
          titleKey: 'notification.conversation_created.title',
          bodyKey: 'notification.conversation_created.body',
          params: params,
        ),
      );
      expect(
        NotificationCopy.body(
          created({'actorDisplayName': 'أحمد', 'conversationType': 'DIRECT'}),
        ),
        'بدأ أحمد محادثة معك.',
      );
      expect(
        NotificationCopy.body(
          created({'actorDisplayName': 'أحمد', 'conversationType': 'CHANNEL'}),
        ),
        'أضافك أحمد إلى قناة جديدة.',
      );
      expect(NotificationCopy.body(created({})), 'أُضفت إلى محادثة جديدة.');
      final added = parse(
        notificationJson(
          type: 'ADDED_TO_CONVERSATION',
          titleKey: 'notification.added_to_conversation.title',
          bodyKey: 'notification.added_to_conversation.body',
          params: {'actorDisplayName': 'أحمد'},
        ),
      );
      expect(NotificationCopy.title(added), 'أُضفت إلى محادثة');
      expect(NotificationCopy.body(added), 'أضافك أحمد إلى محادثة.');
    });

    test('times in Arabic, with number agreement', () {
      final now = DateTime.utc(2026, 9, 10, 12);
      String ago(Duration d) =>
          NotificationCopy.relativeTime(now.subtract(d), now);
      expect(ago(const Duration(seconds: 20)), 'الآن');
      expect(ago(const Duration(minutes: 1)), 'قبل دقيقة');
      expect(ago(const Duration(minutes: 2)), 'قبل دقيقتين');
      expect(ago(const Duration(minutes: 5)), 'قبل 5 دقائق');
      expect(ago(const Duration(minutes: 25)), 'قبل 25 دقيقة');
      expect(ago(const Duration(hours: 1)), 'قبل ساعة');
      expect(ago(const Duration(hours: 3)), 'قبل 3 ساعات');
      expect(ago(const Duration(hours: 13)), 'قبل 13 ساعة');
      expect(ago(const Duration(days: 1)), 'أمس');
      expect(ago(const Duration(days: 2)), 'قبل يومين');
      expect(ago(const Duration(days: 4)), 'قبل 4 أيام');
      expect(ago(const Duration(days: 30)), contains('/'));
    });

    test('the bell says how many — and "more than 99" past the cap', () {
      expect(NotificationCopy.bellLabel(0), 'الإشعارات');
      expect(NotificationCopy.bellLabel(7), 'الإشعارات، 7 غير مقروءة');
      expect(
        NotificationCopy.bellLabel(100),
        'الإشعارات، أكثر من 99 غير مقروءة',
      );
    });
  });
}
