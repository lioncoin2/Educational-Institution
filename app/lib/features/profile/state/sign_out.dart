import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../providers/app_providers.dart';
import '../../notifications/state/push_registration.dart';

/// Signing out on this device. The push registration goes first, while the
/// session can still authenticate that request (ADR 0058) — but never holds the
/// sign-out up: the server stops pushing to an ended session anyway. Then the
/// session ends, and the push token itself is deleted once the session reads
/// signed out (`PushRegistration`). The auth repository's own refusal, if any,
/// reaches the caller.
final signOutProvider = Provider<Future<void> Function()>(
  (ref) => () async {
    try {
      await ref
          .read(pushRegistrationProvider)
          .release()
          .timeout(_releaseAtMost);
    } on Object {
      // Offline or slow: signing out matters more than tidying the device up.
    }
    await ref.read(authRepositoryProvider).signOut();
    ref.invalidate(sessionUserProvider);
  },
);

const _releaseAtMost = Duration(seconds: 3);
