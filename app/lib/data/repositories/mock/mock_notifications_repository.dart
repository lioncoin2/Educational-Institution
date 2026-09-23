import '../../../app/app_config.dart';
import '../../models/notifications.dart';
import '../repositories.dart';

/// In-memory stand-in for `/notifications`, for the demo build and widget
/// tests.
///
/// It keeps the server's rules — newest first with ties by id, opaque
/// cursors, the unread count capped at 99, idempotent reads, "mark all" up
/// to a boundary, preferences per category — so screens built against it
/// behave the same against the real API. The seeded notifications point at
/// the demo conversations of `MockMessagingRepository`; one points at a
/// conversation that no longer exists, as a real inbox eventually will.
class MockNotificationsRepository implements NotificationsRepository {
  MockNotificationsRepository({
    this.latency = AppConfig.fakeLatency,
    DateTime Function()? now,
    bool seed = true,
  }) : _now = now ?? DateTime.now {
    if (seed) _seed();
  }

  final Duration latency;
  final DateTime Function() _now;
  final List<AppNotification> _items = [];
  final Map<String, ChannelPreferences> _preferences = {
    'MESSAGES': const ChannelPreferences(
      category: 'MESSAGES',
      inApp: true,
      realtime: true,
      push: true,
    ),
  };
  final Map<String, RegisteredDevice> _devices = {};

  /// Adds a notification as if the server had just stored one.
  void deliver(AppNotification notification) {
    _items
      ..removeWhere((n) => n.id == notification.id)
      ..add(notification)
      ..sort(AppNotification.newestFirst);
  }

  List<AppNotification> get all => List.unmodifiable(_items);

  @override
  Future<NotificationPage> list({String? cursor, int limit = 20}) async {
    await _wait();
    final start = cursor == null ? 0 : int.tryParse(cursor);
    if (start == null || start < 0) {
      throw const NotificationsException(
        'notifications.cursor_invalid',
        'That page cursor is not valid.',
      );
    }
    final page = _items.skip(start).take(limit).toList();
    final end = start + page.length;
    return NotificationPage(
      items: page,
      nextCursor: end < _items.length ? '$end' : null,
    );
  }

  @override
  Future<UnreadCount> unreadCount() async {
    await _wait();
    final unread = _items.where((n) => !n.isRead).length;
    return unread > UnreadCount.cap
        ? const UnreadCount(UnreadCount.cap, capped: true)
        : UnreadCount(unread);
  }

  @override
  Future<AppNotification> markRead(String notificationId) async {
    await _wait();
    final index = _items.indexWhere((n) => n.id == notificationId);
    if (index < 0) {
      throw const NotificationsException(
        'notifications.notification_not_found',
        'There is no such notification.',
      );
    }
    return _items[index] = _items[index].markedRead(_now());
  }

  @override
  Future<int> markAllRead({String? throughId}) async {
    await _wait();
    var through = (createdAt: _now(), id: null as String?);
    if (throughId != null) {
      final boundary = _items.where((n) => n.id == throughId).firstOrNull;
      if (boundary == null) {
        throw const NotificationsException(
          'notifications.notification_not_found',
          'There is no such notification.',
        );
      }
      through = (createdAt: boundary.createdAt, id: boundary.id);
    }
    var marked = 0;
    for (var i = 0; i < _items.length; i++) {
      final n = _items[i];
      if (!n.isRead && n.isThrough(through.createdAt, through.id)) {
        _items[i] = n.markedRead(_now());
        marked += 1;
      }
    }
    return marked;
  }

  @override
  Future<List<ChannelPreferences>> preferences() async {
    await _wait();
    return _preferences.values.toList();
  }

  @override
  Future<List<ChannelPreferences>> updatePreferences(
    String category, {
    bool? inApp,
    bool? realtime,
    bool? push,
  }) async {
    await _wait();
    final current = _preferences[category];
    if (current == null) {
      throw const NotificationsException(
        'notifications.category_unknown',
        'There are no notifications of that category.',
      );
    }
    _preferences[category] = current.copyWith(
      inApp: inApp,
      realtime: realtime,
      push: push,
    );
    return _preferences.values.toList();
  }

  @override
  Future<RegisteredDevice> registerDevice({
    required String platform,
    required String provider,
    required String token,
  }) async {
    await _wait();
    final device = RegisteredDevice(
      id: 'mock-device-${_devices.length + 1}',
      platform: platform,
      provider: provider,
    );
    return _devices[device.id] = device;
  }

  @override
  Future<void> unregisterDevice(String deviceId) async {
    await _wait();
    if (_devices.remove(deviceId) == null) {
      throw const NotificationsException(
        'notifications.device_not_found',
        'There is no such device.',
      );
    }
  }

  Future<void> _wait() =>
      latency == Duration.zero ? Future.value() : Future.delayed(latency);

  void _seed() {
    final now = _now();
    AppNotification message(
      String id,
      Duration ago,
      String conversationId,
      String conversationType,
      String sender, {
      bool read = false,
    }) => AppNotification(
      id: id,
      type: NotificationType.messageReceived,
      titleKey: 'notification.message_received.title',
      bodyKey: 'notification.message_received.body',
      params: {
        'senderDisplayName': sender,
        'messageType': 'TEXT',
        'conversationType': conversationType,
      },
      target: ConversationTarget(conversationId),
      createdAt: now.subtract(ago),
      readAt: read ? now.subtract(ago) : null,
    );

    for (final notification in [
      message(
        'mock-n1',
        const Duration(minutes: 10),
        'mock-direct',
        'DIRECT',
        'الأستاذ عبدالله',
      ),
      message(
        'mock-n2',
        const Duration(hours: 1),
        'mock-group',
        'GROUP',
        'الأستاذ عبدالله',
      ),
      message(
        'mock-n3',
        const Duration(hours: 3),
        'mock-channel',
        'CHANNEL',
        'إدارة المعهد',
      ),
      AppNotification(
        id: 'mock-n4',
        type: NotificationType.addedToConversation,
        titleKey: 'notification.added_to_conversation.title',
        bodyKey: 'notification.added_to_conversation.body',
        params: const {'actorDisplayName': 'إدارة المعهد'},
        target: const ConversationTarget('mock-channel'),
        createdAt: now.subtract(const Duration(days: 2)),
        readAt: now.subtract(const Duration(days: 2)),
      ),
      AppNotification(
        id: 'mock-n5',
        type: NotificationType.conversationCreated,
        titleKey: 'notification.conversation_created.title',
        bodyKey: 'notification.conversation_created.body',
        params: const {
          'actorDisplayName': 'الأستاذ عبدالله',
          'conversationType': 'GROUP',
        },
        target: const ConversationTarget('mock-group'),
        createdAt: now.subtract(const Duration(days: 3)),
        readAt: now.subtract(const Duration(days: 3)),
      ),
      // A conversation that has since gone: tapping says so, and nothing breaks.
      message(
        'mock-n6',
        const Duration(days: 9),
        'mock-archived',
        'GROUP',
        'الأستاذ عبدالله',
        read: true,
      ),
    ]) {
      deliver(notification);
    }
  }
}
