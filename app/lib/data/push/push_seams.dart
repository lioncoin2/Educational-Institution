/// Push notifications — the device side, as a seam.
///
/// A push token comes from the platform: Firebase Cloud Messaging on Android
/// (and optionally iOS and web), APNs on iOS. Either needs a native plugin
/// (`firebase_messaging`, or an APNs bridge), platform project files
/// (`google-services.json`, `GoogleService-Info.plist`, the Push
/// Notifications capability and an APNs key) and a device or simulator to
/// verify on. None of that can be built or verified in this environment, so
/// no plugin is added — a dependency is not added blind (the same policy as
/// media_seams.dart). See docs/architecture/notifications.md, "Push".
///
/// What exists is everything around the token: the server's device
/// registration API ([NotificationsRepository.registerDevice]), the
/// registration that runs while someone is signed in (`PushRegistration`),
/// and this interface. Binding a plugin is one class implementing
/// [PushTokenSource], and one line in `app_providers.dart`.
///
/// Nothing in this app imports a push SDK; a test asserts it.
library;

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

/// Where the token comes from.
abstract interface class PushTokenSource {
  bool get isAvailable;

  /// The current token, or null when push is unavailable or the person has
  /// not allowed notifications.
  Future<PushToken?> token();
}

/// This build: no push plugin, so no token.
class UnavailablePushTokenSource implements PushTokenSource {
  const UnavailablePushTokenSource();

  @override
  bool get isAvailable => false;

  @override
  Future<PushToken?> token() async => null;
}
