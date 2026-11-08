import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/routes.dart';
import '../../../data/models/notifications.dart';
import '../../../data/push/push_seams.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';
import '../notification_target_resolver.dart';

/// Where a tap on a push notification leads (ADR 0058) — decided as a tap in
/// the inbox is: the notification is marked read, then its target is checked
/// by the module that owns it, which may refuse as for any visit.
///
///   the same tap again              nothing (Android can deliver one twice)
///   not the signed-in person's      the inbox — the push was for an account
///                                   no longer signed in here
///   a target that cannot be opened  the inbox, where the notification is
class PushTapHandler {
  PushTapHandler(this._repository, this._resolver);

  final NotificationsRepository _repository;
  final NotificationTargetResolver _resolver;
  final Set<String> _handled = {};

  /// The location to open for [tap], or null when nothing should open.
  Future<String?> locationFor(PushTap tap) async {
    final id = tap.notificationId;
    if (id != null) {
      if (!_handled.add(id)) return null;
      try {
        await _repository.markRead(id);
      } on NotificationsException catch (error) {
        if (error.code == 'notifications.notification_not_found') {
          return Routes.notifications;
        }
        // Unreachable server: the target's own check below says so, or opens.
      }
    }
    return switch (await _resolver.resolve(tap.target)) {
      OpenRoute(:final location) => location,
      CannotOpen() => Routes.notifications,
    };
  }
}

final pushTapHandlerProvider = Provider<PushTapHandler>(
  (ref) => PushTapHandler(
    ref.watch(notificationsRepositoryProvider),
    ref.watch(notificationTargetResolverProvider),
  ),
);
