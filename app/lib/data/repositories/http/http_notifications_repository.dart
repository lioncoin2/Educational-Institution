import '../../api/api_client.dart';
import '../../models/notifications.dart';
import '../repositories.dart';

/// [NotificationsRepository] against the real backend (`/notifications`).
class HttpNotificationsRepository implements NotificationsRepository {
  HttpNotificationsRepository(this._api);

  final ApiClient _api;

  static String _notification(String id) =>
      '/notifications/${Uri.encodeComponent(id)}';

  @override
  Future<NotificationPage> list({String? cursor, int limit = 20}) => _call(
    () async => NotificationPage.fromJson(
      await _api.get(
        '/notifications',
        query: {'cursor': ?cursor, 'limit': '$limit'},
      ),
    ),
  );

  @override
  Future<UnreadCount> unreadCount() => _call(
    () async =>
        UnreadCount.fromJson(await _api.get('/notifications/unread-count')),
  );

  @override
  Future<AppNotification> markRead(String notificationId) => _call(
    () async => AppNotification.fromJson(
      await _api.post('${_notification(notificationId)}/read'),
    ),
  );

  @override
  Future<int> markAllRead({String? throughId}) => _call(() async {
    final json = await _api.post(
      '/notifications/read-all',
      body: {'throughId': ?throughId},
    );
    return (json['markedRead'] as num?)?.toInt() ?? 0;
  });

  @override
  Future<List<ChannelPreferences>> preferences() => _call(
    () async => ChannelPreferences.listFromJson(
      await _api.get('/notifications/preferences'),
    ),
  );

  @override
  Future<List<ChannelPreferences>> updatePreferences(
    String category, {
    bool? inApp,
    bool? realtime,
    bool? push,
  }) => _call(
    () async => ChannelPreferences.listFromJson(
      await _api.patch(
        '/notifications/preferences',
        body: {
          'category': category,
          'inApp': ?inApp,
          'realtime': ?realtime,
          'push': ?push,
        },
      ),
    ),
  );

  @override
  Future<RegisteredDevice> registerDevice({
    required String platform,
    required String provider,
    required String token,
  }) => _call(
    () async => RegisteredDevice.fromJson(
      await _api.post(
        '/notifications/devices',
        body: {'platform': platform, 'provider': provider, 'token': token},
      ),
    ),
  );

  @override
  Future<void> unregisterDevice(String deviceId) => _call(
    () =>
        _api.delete('/notifications/devices/${Uri.encodeComponent(deviceId)}'),
  );

  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw NotificationsException(error.code, error.message);
    } on FormatException {
      throw const NotificationsException(
        'notifications.unreadable',
        'The server sent something this app cannot read.',
      );
    }
  }
}
