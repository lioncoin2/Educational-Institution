import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/push/push_seams.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_notifications_repository.dart';

/// "Now" in every notifications test.
final testNow = DateTime.utc(2026, 9, 10, 12);

/// A message notification [minutesAgo] before [testNow].
AppNotification note(
  String id, {
  int minutesAgo = 0,
  bool read = false,
  String conversationId = 'mock-direct',
  String sender = 'الأستاذ عبدالله',
}) {
  final at = testNow.subtract(Duration(minutes: minutesAgo));
  return AppNotification(
    id: id,
    type: NotificationType.messageReceived,
    titleKey: 'notification.message_received.title',
    bodyKey: 'notification.message_received.body',
    params: {'senderDisplayName': sender, 'messageType': 'TEXT'},
    target: ConversationTarget(conversationId),
    createdAt: at,
    readAt: read ? at : null,
  );
}

/// The live frame that announces [notification].
NotificationCreatedEvent created(AppNotification notification) =>
    NotificationCreatedEvent(
      eventId: 'notification.created:${notification.id}',
      occurredAt: notification.createdAt,
      notification: notification,
    );

/// The in-memory server with a record of its calls and switches to refuse.
class ScriptedNotifications extends MockNotificationsRepository {
  ScriptedNotifications()
    : super(latency: Duration.zero, now: () => testNow, seed: false);

  int listCalls = 0;
  int countCalls = 0;
  final List<String?> markAllThrough = [];
  final List<String> registeredTokens = [];
  final List<String> unregistered = [];

  /// Set to make the next calls of that kind fail with this code.
  String? failList;
  String? failMarkRead;
  String? failMarkAll;
  String? failPreferences;

  NotificationsException _refusal(String code) =>
      NotificationsException(code, code);

  @override
  Future<NotificationPage> list({String? cursor, int limit = 20}) async {
    listCalls += 1;
    if (failList != null) throw _refusal(failList!);
    return super.list(cursor: cursor, limit: limit);
  }

  @override
  Future<UnreadCount> unreadCount() {
    countCalls += 1;
    return super.unreadCount();
  }

  @override
  Future<AppNotification> markRead(String notificationId) async {
    if (failMarkRead != null) throw _refusal(failMarkRead!);
    return super.markRead(notificationId);
  }

  @override
  Future<int> markAllRead({String? throughId}) async {
    markAllThrough.add(throughId);
    if (failMarkAll != null) throw _refusal(failMarkAll!);
    return super.markAllRead(throughId: throughId);
  }

  @override
  Future<List<ChannelPreferences>> updatePreferences(
    String category, {
    bool? inApp,
    bool? realtime,
    bool? push,
  }) async {
    if (failPreferences != null) throw _refusal(failPreferences!);
    return super.updatePreferences(
      category,
      inApp: inApp,
      realtime: realtime,
      push: push,
    );
  }

  @override
  Future<RegisteredDevice> registerDevice({
    required String platform,
    required String provider,
    required String token,
  }) {
    registeredTokens.add(token);
    return super.registerDevice(
      platform: platform,
      provider: provider,
      token: token,
    );
  }

  @override
  Future<void> unregisterDevice(String deviceId) {
    unregistered.add(deviceId);
    return super.unregisterDevice(deviceId);
  }
}

/// A platform that has a push token to give.
class FakePushTokenSource implements PushTokenSource {
  @override
  bool get isAvailable => true;

  @override
  Future<PushToken?> token() async => const PushToken(
    platform: 'ANDROID',
    provider: 'FCM',
    value: 'fcm-test-token',
  );
}
