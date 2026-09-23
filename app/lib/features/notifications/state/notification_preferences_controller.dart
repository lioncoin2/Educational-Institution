import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/notifications.dart';
import '../../../providers/app_providers.dart';

/// The signed-in person's notification preferences, per category — the
/// server's, changed a switch at a time.
///
/// A change shows at once and is undone (and rethrown, for the screen to
/// say so) if the server refuses; what the server answers replaces it.
class NotificationPreferencesController
    extends AsyncNotifier<List<ChannelPreferences>> {
  @override
  Future<List<ChannelPreferences>> build() =>
      ref.watch(notificationsRepositoryProvider).preferences();

  Future<void> change(
    String category, {
    bool? inApp,
    bool? realtime,
    bool? push,
  }) async {
    final before = state.value;
    if (before == null) return;
    state = AsyncData([
      for (final p in before)
        p.category == category
            ? p.copyWith(inApp: inApp, realtime: realtime, push: push)
            : p,
    ]);
    try {
      final stored = await ref
          .read(notificationsRepositoryProvider)
          .updatePreferences(
            category,
            inApp: inApp,
            realtime: realtime,
            push: push,
          );
      if (ref.mounted) state = AsyncData(stored);
    } on NotificationsException {
      if (ref.mounted) state = AsyncData(before);
      rethrow;
    }
  }
}

final notificationPreferencesProvider =
    AsyncNotifierProvider.autoDispose<
      NotificationPreferencesController,
      List<ChannelPreferences>
    >(NotificationPreferencesController.new, retry: (_, _) => null);
