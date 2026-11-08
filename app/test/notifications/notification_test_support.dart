import 'dart:async';

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

/// A platform with push, scripted: what the permission is and what asking
/// answers, the token it gives, and a record of what was asked of it.
class FakePushTokenSource implements PushTokenSource {
  /// [log] may be shared with the test's other fakes, to see one order.
  FakePushTokenSource([List<String>? log]) : log = log ?? [];

  PushPermission permissionNow = PushPermission.granted;

  /// What the system dialog answers; it becomes [permissionNow].
  PushPermission answer = PushPermission.granted;
  String tokenValue = 'fcm-test-token';
  bool offered = false;
  PushTap? startedBy;
  int requests = 0;
  int disabled = 0;

  /// Every call that changes something, in order.
  final List<String> log;

  final _refreshes = StreamController<PushToken>.broadcast();
  final _taps = StreamController<PushTap>.broadcast();

  /// The provider rotates the token.
  void rotate(String value) {
    tokenValue = value;
    _refreshes.add(
      PushToken(platform: 'ANDROID', provider: 'FCM', value: value),
    );
  }

  /// A notification is tapped while the app runs.
  void tap(PushTap tap) => _taps.add(tap);

  @override
  bool get isAvailable => true;

  @override
  Future<PushPermission> permission() async => permissionNow;

  @override
  Future<PushPermission> requestPermission() async {
    requests += 1;
    log.add('request');
    return permissionNow = answer;
  }

  @override
  Future<PushToken?> token() async =>
      PushToken(platform: 'ANDROID', provider: 'FCM', value: tokenValue);

  @override
  Stream<PushToken> get tokenRefreshes => _refreshes.stream;

  @override
  Future<PushTap?> initialTap() async {
    final tap = startedBy;
    startedBy = null;
    return tap;
  }

  @override
  Stream<PushTap> get taps => _taps.stream;

  /// When set, [disable] waits for it — to see what waits for a deletion.
  Completer<void>? disableGate;

  @override
  Future<void> disable() async {
    await disableGate?.future;
    disabled += 1;
    log.add('disable');
  }

  @override
  Future<bool> wasOffered() async => offered;

  @override
  Future<void> markOffered() async {
    offered = true;
    log.add('offered');
  }
}
