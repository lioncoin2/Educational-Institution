import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/auth.dart';
import '../../../providers/app_providers.dart';

/// The signed-in user's own device sessions (`GET /auth/sessions`) and ending
/// one (`DELETE /auth/sessions/:id`).
///
/// The server answers by the authenticated identity and reports another user's
/// or a missing session alike as `identity.session_not_found`, so this never
/// exposes or acts on a session that is not the caller's. All network access is
/// the [AuthRepository]'s; this controller only orchestrates load/refresh and
/// surfaces failures as state — no HTTP or business logic leaks into widgets.
class SessionsController extends AsyncNotifier<List<DeviceSession>> {
  @override
  Future<List<DeviceSession>> build() =>
      ref.watch(authRepositoryProvider).sessions();

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  /// Ends one of the user's OTHER sessions, then reloads so a revoked row
  /// disappears. Signing out THIS device is the account section's job (it also
  /// clears this device's tokens), so the screen never ends the current session
  /// here — doing so would duplicate sign-out and strand stale local tokens.
  /// Throws [AuthException] with the server's code on refusal
  /// (`identity.session_not_found` for an already-gone or foreign session).
  Future<void> endSession(String sessionId) async {
    await ref.read(authRepositoryProvider).endSession(sessionId);
    await refresh();
  }
}

final sessionsProvider =
    AsyncNotifierProvider.autoDispose<SessionsController, List<DeviceSession>>(
  SessionsController.new,
  retry: (_, _) => null,
);
