import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/notifications.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';
import 'push_registration.dart';

/// How many notifications are unread — the ONE source every badge reads
/// (the bell on Home and Programs, the Profile row, the center itself).
///
/// It is the server's count (`GET /notifications/unread-count`, capped at
/// 99), fetched when someone signs in and whenever the live connection comes
/// (back) up, and kept current in between:
///
///   notification.created   +1 at once for a new unread one (each id once),
///                          then the server's count again, quietly
///   notification.read /    read on another device: the server's count
///   notification.read_all
///   read here              the center tells it ([noteRead], [noteAllRead])
///
/// Nothing is counted on this device from a loaded list: the list is a page,
/// the count is the whole inbox.
class UnreadCountController extends AsyncNotifier<UnreadCount> {
  final Set<String> _counted = {};
  Future<void>? _refreshing;
  bool _again = false;

  @override
  Future<UnreadCount> build() async {
    // A different account is a different inbox — counted again only when the
    // account changes, not while the session merely resolves.
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    // Keeps this device registered for push while someone is signed in.
    ref.watch(pushRegistrationProvider);
    final repository = ref.watch(notificationsRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });
    _counted.clear();
    return _fetch(repository);
  }

  /// Fetches the server's count again, quietly: what is shown stays until
  /// the answer arrives, and a failure keeps it. One request at a time; a
  /// request asked for meanwhile runs once more after it.
  Future<void> refresh() {
    if (_refreshing != null) {
      _again = true;
      return _refreshing!;
    }
    return _refreshing = _refreshLoop().whenComplete(() => _refreshing = null);
  }

  /// One notification was read on this device.
  void noteRead() {
    final current = state.value;
    if (current != null && !current.capped) {
      state = AsyncData(current.plus(-1));
    }
    unawaited(refresh());
  }

  /// Everything shown was marked read on this device.
  void noteAllRead() {
    if (state.value != null) state = const AsyncData(UnreadCount.zero);
    unawaited(refresh());
  }

  Future<void> _refreshLoop() async {
    do {
      _again = false;
      try {
        final count = await _fetch(ref.read(notificationsRepositoryProvider));
        if (!ref.mounted) return;
        state = AsyncData(count);
      } on NotificationsException {
        // Keep what is shown; the next event or reconnect tries again.
      }
    } while (_again && ref.mounted);
  }

  Future<UnreadCount> _fetch(NotificationsRepository repository) async {
    try {
      return await repository.unreadCount();
    } on NotificationsException catch (error) {
      // Nobody signed in: there is no inbox, so there is nothing unread.
      if (error.needsSignIn) return UnreadCount.zero;
      rethrow;
    }
  }

  void _onEvent(RealtimeEvent event) {
    switch (event) {
      case NotificationCreatedEvent(:final notification):
        if (notification.isRead || !_counted.add(notification.id)) return;
        final current = state.value;
        if (current != null) state = AsyncData(current.plus(1));
        unawaited(refresh());
      case NotificationReadEvent() || NotificationsReadAllEvent():
        unawaited(refresh());
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(refresh());
  }
}

final unreadCountProvider =
    AsyncNotifierProvider<UnreadCountController, UnreadCount>(
      UnreadCountController.new,
      retry: (_, _) => null,
    );

/// The count as a badge reads it: 0 for none (or unknown), above 99 for
/// "99+" (see `UnreadBadge`).
final unreadNotificationCountProvider = Provider<int>(
  (ref) => ref.watch(unreadCountProvider).value?.badgeValue ?? 0,
);
