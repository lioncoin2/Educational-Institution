import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/auth.dart';
import '../../../data/models/notifications.dart';
import '../../../data/push/push_seams.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';

/// Keeps this device registered for push while someone is signed in on it.
///
/// On sign-in it asks the [PushTokenSource] for a token and registers it
/// with the server (which binds it to the signed-in account — a token
/// another account registered earlier moves here, so a shared device stops
/// receiving the previous person's pushes). [release] unregisters it, and a
/// sign-out flow calls it BEFORE signing out, while the session can still
/// authenticate the request.
///
/// In this build the source is `UnavailablePushTokenSource`, so nothing is
/// ever registered: push is designed and served, not yet bound to a native
/// plugin (see push_seams.dart).
class PushRegistration {
  PushRegistration(this._source, this._repository);

  final PushTokenSource _source;
  final NotificationsRepository _repository;
  String? _deviceId;

  /// The registered device, if any.
  String? get deviceId => _deviceId;

  /// Registers this device's current token. Failures are quiet: push is a
  /// convenience, and the inbox has everything.
  Future<void> register() async {
    if (!_source.isAvailable) return;
    final token = await _source.token();
    if (token == null) return;
    try {
      final device = await _repository.registerDevice(
        platform: token.platform,
        provider: token.provider,
        token: token.value,
      );
      _deviceId = device.id;
    } on NotificationsException {
      // Tried again at the next sign-in or start.
    }
  }

  /// Unregisters this device, if it was registered.
  Future<void> release() async {
    final id = _deviceId;
    if (id == null) return;
    _deviceId = null;
    try {
      await _repository.unregisterDevice(id);
    } on NotificationsException {
      // Already gone, or the server is unreachable: the next account to sign
      // in on this device takes the token over anyway.
    }
  }
}

final pushRegistrationProvider = Provider<PushRegistration>((ref) {
  final registration = PushRegistration(
    ref.watch(pushTokenSourceProvider),
    ref.watch(notificationsRepositoryProvider),
  );
  ref.listen<AsyncValue<CurrentUser?>>(sessionUserProvider, (_, next) {
    if (next.value != null) unawaited(registration.register());
  }, fireImmediately: true);
  return registration;
});
