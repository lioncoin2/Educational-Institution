import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/notifications.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../providers/app_providers.dart';
import 'unread_count_controller.dart';

class NotificationListState {
  const NotificationListState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  /// Newest first, as the server orders them; each notification once.
  final List<AppNotification> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;
  bool get hasUnread => items.any((n) => !n.isRead);

  NotificationListState copyWith({
    List<AppNotification>? items,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => NotificationListState(
    items: items ?? this.items,
    nextCursor: nextCursor,
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
  );
}

/// The notification center's list: the inbox a page at a time, kept current
/// by the live connection while the center is open.
///
///   notification.created   inserted in its place — once, however often it
///                          arrives
///   notification.read      read on another device: shown read here
///   notification.read_all  everything up to the boundary shown read
///
/// Whenever the connection comes (back) up, the first page is fetched again
/// and merged: whatever arrived while it was down is in there.
///
/// Reading is optimistic — the item shows read at once — and undone if the
/// server refuses, so what is shown never claims more than the server has.
class NotificationListController extends AsyncNotifier<NotificationListState> {
  Future<void>? _resyncing;

  @override
  Future<NotificationListState> build() async {
    final repository = ref.watch(notificationsRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });
    final page = await repository.list();
    return NotificationListState(
      items: _merged(const [], page.items),
      nextCursor: page.nextCursor,
    );
  }

  /// The next page, appended. A failure keeps what is shown and offers retry.
  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await ref
          .read(notificationsRepositoryProvider)
          .list(cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      state = AsyncData(
        NotificationListState(
          items: _merged(now.items, page.items),
          nextCursor: page.nextCursor,
        ),
      );
    } on NotificationsException {
      if (!ref.mounted) return;
      state = AsyncData(
        (state.value ?? current).copyWith(
          loadingMore: false,
          loadMoreFailed: true,
        ),
      );
    }
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  /// Marks one read: shown at once, confirmed by the server, undone (and
  /// rethrown) if it refuses.
  Future<void> markRead(AppNotification notification) async {
    if (notification.isRead) return;
    final now = ref.read(clockProvider)();
    _replace(notification.id, (n) => n.markedRead(now));
    try {
      final stored = await ref
          .read(notificationsRepositoryProvider)
          .markRead(notification.id);
      if (!ref.mounted) return;
      _replace(notification.id, (_) => stored);
      ref.read(unreadCountProvider.notifier).noteRead();
    } on NotificationsException {
      if (ref.mounted) _replace(notification.id, (n) => n.markedUnread());
      rethrow;
    }
  }

  /// Marks read everything up to the newest one shown — not what arrives
  /// meanwhile. Undone (and rethrown) if the server refuses.
  Future<void> markAllRead() async {
    final current = state.value;
    if (current == null || current.items.isEmpty) return;
    final through = current.items.first;
    final now = ref.read(clockProvider)();
    final before = current.items;
    state = AsyncData(
      current.copyWith(
        items: [
          for (final n in before)
            n.isThrough(through.createdAt, through.id) ? n.markedRead(now) : n,
        ],
      ),
    );
    try {
      await ref
          .read(notificationsRepositoryProvider)
          .markAllRead(throughId: through.id);
      if (!ref.mounted) return;
      ref.read(unreadCountProvider.notifier).noteAllRead();
    } on NotificationsException {
      if (ref.mounted) {
        final shown = state.value;
        if (shown != null) {
          final wasRead = {
            for (final n in before)
              if (n.isRead) n.id,
          };
          state = AsyncData(
            shown.copyWith(
              items: [
                for (final n in shown.items)
                  // Undo only what this call marked; keep what others did.
                  n.isThrough(through.createdAt, through.id) &&
                          !wasRead.contains(n.id)
                      ? n.markedUnread()
                      : n,
              ],
            ),
          );
        }
      }
      rethrow;
    }
  }

  void _onEvent(RealtimeEvent event) {
    final current = state.value;
    if (current == null) return; // Loading: the first page covers it.
    switch (event) {
      case NotificationCreatedEvent(:final notification):
        if (current.items.any((n) => n.id == notification.id)) return;
        state = AsyncData(
          current.copyWith(items: _merged(current.items, [notification])),
        );
      case NotificationReadEvent(:final notificationId, :final readAt):
        _replace(notificationId, (n) => n.markedRead(readAt));
      case NotificationsReadAllEvent(
        :final throughCreatedAt,
        :final throughId,
        :final readAt,
      ):
        state = AsyncData(
          current.copyWith(
            items: [
              for (final n in current.items)
                n.isThrough(throughCreatedAt, throughId)
                    ? n.markedRead(readAt)
                    : n,
            ],
          ),
        );
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(_resync());
  }

  /// The first page again, merged in quietly. One at a time; a failure keeps
  /// what is shown.
  Future<void> _resync() {
    return _resyncing ??= _fetchFirstPage().whenComplete(
      () => _resyncing = null,
    );
  }

  Future<void> _fetchFirstPage() async {
    if (state.value == null) return;
    try {
      final page = await ref.read(notificationsRepositoryProvider).list();
      if (!ref.mounted) return;
      final current = state.value;
      if (current == null) return;
      state = AsyncData(
        current.copyWith(items: _merged(current.items, page.items)),
      );
    } on NotificationsException {
      // The next event or reconnect tries again.
    }
  }

  void _replace(String id, AppNotification Function(AppNotification) change) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        items: [for (final n in current.items) n.id == id ? change(n) : n],
      ),
    );
  }

  /// [existing] and [incoming] as one list: each id once — the incoming
  /// copy wins, as the newer word — newest first.
  static List<AppNotification> _merged(
    List<AppNotification> existing,
    List<AppNotification> incoming,
  ) {
    final byId = {for (final n in existing) n.id: n};
    for (final n in incoming) {
      final known = byId[n.id];
      // Never un-read something already shown read: a stale page may lag.
      byId[n.id] = known != null && known.isRead && !n.isRead ? known : n;
    }
    return byId.values.toList()..sort(AppNotification.newestFirst);
  }
}

final notificationListProvider =
    AsyncNotifierProvider.autoDispose<
      NotificationListController,
      NotificationListState
    >(
      NotificationListController.new,
      // Failures surface at once with a retry button; no silent backoff.
      retry: (_, _) => null,
    );
