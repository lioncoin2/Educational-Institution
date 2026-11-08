/// Push notifications — the device side, as a seam.
///
/// A push token comes from the platform. This build binds Firebase Cloud
/// Messaging on Android only (ADR 0058): `firebase_push.dart` is the ONE file
/// that knows Firebase, and it is chosen in `app_providers.dart` only for a
/// backend build made with `--dart-define=PUSH_ENABLED=true` (and the
/// project's `google-services.json`). iOS and the web stay unavailable: APNs
/// needs credentials and a device to verify on, the web a service worker.
///
/// What a push says is decided on the server and rendered by Android from the
/// app's string resources — the kind of thing that happened, never a name or
/// a message. Everything else is around the token: the registration that runs
/// while someone is signed in (`PushRegistration`), and the tap that opens
/// the app on the notification's target (`PushTaps`).
library;

import '../models/notifications.dart';

/// This installation's address with a push provider.
class PushToken {
  const PushToken({
    required this.platform,
    required this.provider,
    required this.value,
  });

  /// `IOS`, `ANDROID` or `WEB`.
  final String platform;

  /// `FCM` or `APNS`.
  final String provider;

  /// The token itself. Sent to our server once per registration; never
  /// logged, never shown.
  final String value;
}

/// Whether this device may show notifications for the app.
enum PushPermission {
  granted,

  /// Never asked: the system dialog can be shown.
  notDetermined,

  /// Refused, but the system will ask again.
  denied,

  /// Refused for good: only the system settings can turn it on.
  deniedPermanently,

  /// This build or device cannot receive push at all (no push here, or a
  /// build missing its Firebase configuration) — nothing to ask, nothing to say.
  unsupported,
}

/// A tap on a push notification: which notification, and where it leads.
/// Identifiers only — the push carried nothing else.
class PushTap {
  const PushTap({required this.notificationId, required this.target});

  /// Null when the push did not say (a malformed one).
  final String? notificationId;
  final NotificationTarget target;

  /// Reads a push's data payload (`notificationId`, `target` as JSON text);
  /// what it cannot read becomes an [UnsupportedTarget], never an error.
  factory PushTap.fromData(Map<String, Object?> data) {
    final id = data['notificationId'];
    return PushTap(
      notificationId: id is String && id.isNotEmpty ? id : null,
      target: NotificationTarget.fromJsonText(data['target']),
    );
  }
}

/// Where the token comes from, and what the platform reports about push.
abstract interface class PushTokenSource {
  /// Whether this build can receive push at all.
  bool get isAvailable;

  /// The current permission, without asking.
  Future<PushPermission> permission();

  /// Asks the person (the system dialog), when the system still may.
  Future<PushPermission> requestPermission();

  /// The current token, or null when push is unavailable or not allowed.
  Future<PushToken?> token();

  /// A new token for this installation (the provider rotated it).
  Stream<PushToken> get tokenRefreshes;

  /// The tap that started the app from a notification, if it did — once.
  Future<PushTap?> initialTap();

  /// Taps that bring the running app to the front.
  Stream<PushTap> get taps;

  /// This installation stops being reachable: its token is deleted (so a
  /// later sign-in gets a new one) and its notifications leave the tray.
  Future<void> disable();

  /// Whether the app has already offered to turn notifications on — it does
  /// so once per installation, before the system's own question.
  Future<bool> wasOffered();

  Future<void> markOffered();
}

/// This build: no push, so no token.
class UnavailablePushTokenSource implements PushTokenSource {
  const UnavailablePushTokenSource();

  @override
  bool get isAvailable => false;

  @override
  Future<PushPermission> permission() async => PushPermission.unsupported;

  @override
  Future<PushPermission> requestPermission() async =>
      PushPermission.unsupported;

  @override
  Future<PushToken?> token() async => null;

  @override
  Stream<PushToken> get tokenRefreshes => const Stream.empty();

  @override
  Future<PushTap?> initialTap() async => null;

  @override
  Stream<PushTap> get taps => const Stream.empty();

  @override
  Future<void> disable() async {}

  @override
  Future<bool> wasOffered() async => true;

  @override
  Future<void> markOffered() async {}
}
