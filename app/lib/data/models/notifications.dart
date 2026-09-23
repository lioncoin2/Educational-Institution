/// Notifications — the signed-in person's inbox, as the server keeps it
/// (backend/src/modules/notifications). The server stores keys and values,
/// never sentences: what a notification SAYS is decided here, in Arabic, by
/// `NotificationCopy`, from its [AppNotification.titleKey], [AppNotification.bodyKey]
/// and [AppNotification.params].
///
/// Everything is parsed defensively: a type, a target or a parameter this
/// version does not know is kept as "unknown" and shown generically — a
/// newer server never breaks an older app.
library;

/// What a notification is about. [unknown] is anything this version of the
/// app has not heard of.
enum NotificationType {
  messageReceived('MESSAGE_RECEIVED'),
  conversationCreated('CONVERSATION_CREATED'),
  addedToConversation('ADDED_TO_CONVERSATION'),
  assignmentCreated('ASSIGNMENT_CREATED'),
  assignmentUpdated('ASSIGNMENT_UPDATED'),
  announcementCreated('ANNOUNCEMENT_CREATED'),
  certificateIssued('CERTIFICATE_ISSUED'),
  halaqaUpdate('HALAQA_UPDATE'),
  unknown('UNKNOWN');

  const NotificationType(this.wire);

  final String wire;

  static NotificationType fromWire(String? value) =>
      values.firstWhere((type) => type.wire == value, orElse: () => unknown);
}

/// Where tapping a notification leads: an address inside the app, never a
/// URL. Opening it still goes through the destination's own API, which
/// decides — as for any request — whether the person may see it.
sealed class NotificationTarget {
  const NotificationTarget();

  /// A target this version can open, or [UnsupportedTarget] for anything
  /// else — including a malformed one. Never throws.
  static NotificationTarget fromJson(Object? json) {
    if (json is! Map) return const UnsupportedTarget('');
    final kind = json['kind'];
    if (kind is! String) return const UnsupportedTarget('');
    if (kind == 'conversation') {
      final id = json['conversationId'];
      if (id is String && _identifier.hasMatch(id)) {
        return ConversationTarget(id);
      }
    }
    return UnsupportedTarget(kind);
  }

  static final _identifier = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
}

final class ConversationTarget extends NotificationTarget {
  const ConversationTarget(this.conversationId);

  final String conversationId;

  @override
  bool operator ==(Object other) =>
      other is ConversationTarget && other.conversationId == conversationId;

  @override
  int get hashCode => conversationId.hashCode;
}

/// A kind this version cannot open (a newer server's), or a broken one.
final class UnsupportedTarget extends NotificationTarget {
  const UnsupportedTarget(this.kind);

  final String kind;
}

class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.titleKey,
    required this.bodyKey,
    required this.params,
    required this.target,
    required this.createdAt,
    this.readAt,
  });

  /// Throws [FormatException] when the notification cannot even be
  /// identified or dated; anything else unknown is tolerated.
  factory AppNotification.fromJson(Map<String, Object?> json) {
    final id = json['id'];
    final createdAt = DateTime.tryParse(json['createdAt'] as String? ?? '');
    if (id is! String || id.isEmpty || createdAt == null) {
      throw const FormatException('not a notification');
    }
    final readAt = json['readAt'];
    return AppNotification(
      id: id,
      type: NotificationType.fromWire(json['type'] as String?),
      titleKey: json['titleKey'] is String ? json['titleKey']! as String : '',
      bodyKey: json['bodyKey'] is String ? json['bodyKey']! as String : '',
      params: _params(json['params']),
      target: NotificationTarget.fromJson(json['target']),
      createdAt: createdAt,
      readAt: readAt is String ? DateTime.tryParse(readAt) : null,
    );
  }

  final String id;
  final NotificationType type;
  final String titleKey;
  final String bodyKey;

  /// Plain values only — text, numbers, flags. Shown as text, never
  /// interpreted.
  final Map<String, Object> params;
  final NotificationTarget target;
  final DateTime createdAt;
  final DateTime? readAt;

  bool get isRead => readAt != null;

  /// The text parameter [name], when there is one.
  String? text(String name) {
    final value = params[name];
    return value is String && value.trim().isNotEmpty ? value : null;
  }

  AppNotification markedRead(DateTime at) => isRead ? this : _copy(readAt: at);

  AppNotification markedUnread() => _copy(readAt: null);

  AppNotification _copy({required DateTime? readAt}) => AppNotification(
    id: id,
    type: type,
    titleKey: titleKey,
    bodyKey: bodyKey,
    params: params,
    target: target,
    createdAt: createdAt,
    readAt: readAt,
  );

  /// Newest first, ties by id — the server's order, so a page and a live
  /// insertion always agree on where a notification goes.
  static int newestFirst(AppNotification a, AppNotification b) {
    final byTime = b.createdAt.compareTo(a.createdAt);
    return byTime != 0 ? byTime : b.id.compareTo(a.id);
  }

  /// Whether this notification is at or before a "mark all read" boundary.
  bool isThrough(DateTime throughCreatedAt, String? throughId) {
    final byTime = createdAt.compareTo(throughCreatedAt);
    if (byTime != 0) return byTime < 0;
    return throughId == null || id.compareTo(throughId) <= 0;
  }

  static Map<String, Object> _params(Object? json) {
    if (json is! Map) return const {};
    return {
      for (final entry in json.entries)
        if (entry.key is String &&
            (entry.value is String ||
                entry.value is num ||
                entry.value is bool))
          entry.key as String: entry.value as Object,
    };
  }
}

class NotificationPage {
  const NotificationPage({required this.items, this.nextCursor});

  /// Unreadable items are skipped, never fatal to the page.
  factory NotificationPage.fromJson(Map<String, Object?> json) =>
      NotificationPage(
        items: [
          for (final item in (json['items'] as List? ?? const []))
            if (item is Map) ?_tryParse(item.cast<String, Object?>()),
        ],
        nextCursor: json['nextCursor'] as String?,
      );

  final List<AppNotification> items;
  final String? nextCursor;

  static AppNotification? _tryParse(Map<String, Object?> json) {
    try {
      return AppNotification.fromJson(json);
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    }
  }
}

/// How many notifications are unread — counted by the server up to [cap],
/// beyond which it only says "more" ([capped]).
class UnreadCount {
  const UnreadCount(this.count, {this.capped = false});

  factory UnreadCount.fromJson(Map<String, Object?> json) => UnreadCount(
    (json['count'] as num?)?.toInt() ?? 0,
    capped: json['capped'] == true,
  );

  static const zero = UnreadCount(0);

  /// The server's cap.
  static const cap = 99;

  final int count;
  final bool capped;

  /// A single number for badges: anything above [cap] means "99+".
  int get badgeValue => capped ? cap + 1 : count;

  UnreadCount plus(int delta) {
    if (capped && delta >= 0) return this;
    final next = count + delta;
    if (next > cap) return const UnreadCount(cap, capped: true);
    return UnreadCount(next < 0 ? 0 : next);
  }

  @override
  bool operator ==(Object other) =>
      other is UnreadCount && other.count == count && other.capped == capped;

  @override
  int get hashCode => Object.hash(count, capped);

  @override
  String toString() => 'UnreadCount($count${capped ? '+' : ''})';
}

/// One category's channels, as the person set them.
class ChannelPreferences {
  const ChannelPreferences({
    required this.category,
    required this.inApp,
    required this.realtime,
    required this.push,
  });

  factory ChannelPreferences.fromJson(Map<String, Object?> json) =>
      ChannelPreferences(
        category: json['category']! as String,
        inApp: json['inApp'] != false,
        realtime: json['realtime'] != false,
        push: json['push'] != false,
      );

  static List<ChannelPreferences> listFromJson(Map<String, Object?> json) => [
    for (final item in (json['categories'] as List? ?? const []))
      if (item is Map)
        ChannelPreferences.fromJson(item.cast<String, Object?>()),
  ];

  /// `MESSAGES` — the only category with notifications today.
  final String category;

  /// Kept in the notification center. Off: nothing is stored, so nothing
  /// is delivered live or pushed either.
  final bool inApp;

  /// Announced live while the app is open.
  final bool realtime;

  /// Sent to this person's devices.
  final bool push;

  ChannelPreferences copyWith({bool? inApp, bool? realtime, bool? push}) =>
      ChannelPreferences(
        category: category,
        inApp: inApp ?? this.inApp,
        realtime: realtime ?? this.realtime,
        push: push ?? this.push,
      );

  @override
  bool operator ==(Object other) =>
      other is ChannelPreferences &&
      other.category == category &&
      other.inApp == inApp &&
      other.realtime == realtime &&
      other.push == push;

  @override
  int get hashCode => Object.hash(category, inApp, realtime, push);
}

/// A device registered for push. The server never returns its token.
class RegisteredDevice {
  const RegisteredDevice({
    required this.id,
    required this.platform,
    required this.provider,
  });

  factory RegisteredDevice.fromJson(Map<String, Object?> json) =>
      RegisteredDevice(
        id: json['id']! as String,
        platform: json['platform']! as String,
        provider: json['provider']! as String,
      );

  final String id;
  final String platform;
  final String provider;
}

class NotificationsException implements Exception {
  const NotificationsException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  @override
  String toString() => 'NotificationsException($code): $message';
}
