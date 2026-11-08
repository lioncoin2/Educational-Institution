import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/auth.dart';
import '../../../data/models/notifications.dart';
import '../../../data/push/push_seams.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';

/// Keeps this device registered for push exactly while someone is signed in
/// on it and allows notifications (ADR 0058).
///
///   signed in, allowed   the token is registered — again only when the token
///                        or the account changed. The server binds it to the
///                        session it came through, and moves a token another
///                        account held, so a shared phone stops receiving the
///                        last person's push.
///   token rotated        registered again, for whoever is signed in
///   explicit sign-out    [release] first, while the session can still
///                        authenticate the request (the sign-out flow calls it)
///   signed out, any way  [disable]: the token is deleted and the tray cleared —
///                        also when the server ended the session; the server
///                        stops pushing to an ended session in any case
///   switched off         the device is released and the token deleted —
///                        found at the next start, sign-in or resume
///   switched on again    [resumed] registers when the app comes back
///
/// One operation runs at a time, in the order asked.
///
/// Failures are quiet: push is a convenience, and the inbox has everything.
class PushRegistration {
  PushRegistration(this._source, this._repository);

  final PushTokenSource _source;
  final NotificationsRepository _repository;
  String? _deviceId;
  ({String userId, String token})? _registered;
  Future<void> _queue = Future<void>.value();

  /// The registered device, if any.
  String? get deviceId => _deviceId;

  /// Registers this device for [userId] — if this build has push and the
  /// person allows it.
  Future<void> register(String userId) => _serially(() => _registerNow(userId));

  /// The provider rotated this installation's token.
  Future<void> refreshed(String userId, PushToken token) =>
      _serially(() => _register(userId, token));

  /// Unregisters this device, if it was registered.
  Future<void> release() => _serially(_releaseNow);

  /// Nobody is signed in: this installation must not stay reachable.
  Future<void> disable() => _serially(_disableNow);

  /// The app came back to the front: notifications may have been switched on
  /// or off in the system settings meanwhile.
  Future<void> resumed(String? userId) => _serially(() async {
    if (!_source.isAvailable || userId == null) return;
    await _registerNow(userId);
  });

  /// One operation at a time, in the order asked — a token is never fetched
  /// while the last one is still being deleted. A failure never blocks the next.
  Future<void> _serially(Future<void> Function() operation) {
    final next = _queue.then((_) => operation());
    _queue = next.catchError((Object _) {});
    return next;
  }

  Future<void> _registerNow(String userId) async {
    if (!_source.isAvailable) return;
    final permission = await _source.permission();
    if (permission == PushPermission.denied ||
        permission == PushPermission.deniedPermanently) {
      // Switched off in the system settings: the server forgets the device,
      // and the token is deleted, so nothing is pushed to it in vain.
      await _releaseNow();
      await _disableNow();
      return;
    }
    if (permission != PushPermission.granted) return;
    final token = await _source.token();
    if (token != null) await _register(userId, token);
  }

  Future<void> _register(String userId, PushToken token) async {
    final last = _registered;
    if (last != null && last.userId == userId && last.token == token.value) {
      return;
    }
    try {
      final device = await _repository.registerDevice(
        platform: token.platform,
        provider: token.provider,
        token: token.value,
      );
      _deviceId = device.id;
      _registered = (userId: userId, token: token.value);
    } on NotificationsException {
      // Tried again at the next start, sign-in or token.
    }
  }

  Future<void> _releaseNow() async {
    final id = _deviceId;
    _deviceId = null;
    _registered = null;
    if (id == null) return;
    try {
      await _repository.unregisterDevice(id);
    } on NotificationsException {
      // Already gone, or the server is unreachable: the device is bound to a
      // session that is ending, and the server stops pushing to it.
    }
  }

  Future<void> _disableNow() async {
    _deviceId = null;
    _registered = null;
    await _source.disable();
  }
}

final pushRegistrationProvider = Provider<PushRegistration>((ref) {
  final source = ref.watch(pushTokenSourceProvider);
  final registration = PushRegistration(
    source,
    ref.watch(notificationsRepositoryProvider),
  );
  ref.listen<AsyncValue<CurrentUser?>>(sessionUserProvider, (_, next) {
    // A session still resolving, or one that could not be read, changes nothing.
    if (next.isLoading || next.hasError) return;
    final user = next.value;
    unawaited(
      user != null ? registration.register(user.id) : registration.disable(),
    );
  }, fireImmediately: true);
  final refreshes = source.tokenRefreshes.listen((token) {
    final user = ref.read(sessionUserProvider).value;
    if (user != null) unawaited(registration.refreshed(user.id, token));
  });
  ref.onDispose(refreshes.cancel);
  return registration;
});
