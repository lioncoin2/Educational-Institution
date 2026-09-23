import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/backend_config.dart';
import '../../app/routes.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../core/widgets/patterns/notification_tile.dart';
import '../../data/models/notifications.dart';
import '../../providers/app_providers.dart';
import 'notification_copy.dart';
import 'notification_target_resolver.dart';
import 'state/notification_list_controller.dart';
import 'state/unread_count_controller.dart';

/// مركز الإشعارات — the signed-in person's notifications, newest first,
/// kept current live while it is open.
///
/// Tapping one marks it read, then asks the owning module whether its
/// target may still be opened, and only then goes there — so a notification
/// about a conversation someone has since left says "no longer available"
/// instead of opening onto a refusal.
class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(unreadNotificationCountProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text(NotificationCopy.screenTitle),
        actions: [
          // Icons rather than text buttons: at the largest text scale an
          // Arabic label plus the title no longer fits a 360pt app bar.
          if (unread > 0)
            IconButton(
              tooltip: NotificationCopy.markAllRead,
              onPressed: () => unawaited(_markAllRead(context, ref)),
              icon: const Icon(Icons.done_all_rounded),
            ),
          IconButton(
            tooltip: NotificationCopy.settings,
            onPressed: () => context.push(Routes.notificationSettings),
            icon: const Icon(Icons.tune_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        // Against the real backend, a session comes first; the demo build
        // runs on mock data and needs none.
        child: BackendConfig.isConfigured
            ? AsyncView(
                value: ref.watch(sessionUserProvider),
                onRetry: () => ref.invalidate(sessionUserProvider),
                builder: (context, user) => user == null
                    ? EmptyState(
                        icon: Icons.lock_outline_rounded,
                        title: NotificationCopy.signInTitle,
                        actionLabel: NotificationCopy.signIn,
                        onAction: () => context.push(Routes.signIn),
                      )
                    : const _NotificationList(),
              )
            : const _NotificationList(),
      ),
    );
  }

  static Future<void> _markAllRead(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(notificationListProvider.notifier).markAllRead();
    } on NotificationsException catch (error) {
      if (context.mounted) _say(context, NotificationCopy.error(error.code));
    }
  }
}

class _NotificationList extends ConsumerWidget {
  const _NotificationList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifications = ref.watch(notificationListProvider);
    final now = ref.watch(clockProvider)();
    return AsyncView(
      value: notifications,
      onRetry: () => ref.invalidate(notificationListProvider),
      builder: (context, state) {
        if (state.items.isEmpty) {
          return const EmptyState(
            icon: Icons.notifications_off_outlined,
            title: NotificationCopy.empty,
            message: NotificationCopy.emptyMessage,
          );
        }
        return RefreshIndicator(
          onRefresh: () => Future.wait([
            ref.read(notificationListProvider.notifier).refresh(),
            ref.read(unreadCountProvider.notifier).refresh(),
          ]),
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: Insets.giant),
            itemCount: state.items.length + 2,
            itemBuilder: (context, index) {
              if (index == 0) {
                return BackendConfig.isConfigured
                    ? const SizedBox(height: Insets.md)
                    : const ResponsiveBody(
                        child: Padding(
                          padding: EdgeInsets.symmetric(vertical: Insets.md),
                          child: MockBanner(
                            message: NotificationCopy.demoBanner,
                          ),
                        ),
                      );
              }
              if (index == state.items.length + 1) return _Footer(state: state);
              final notification = state.items[index - 1];
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.md),
                  child: NotificationTile(
                    key: ValueKey(notification.id),
                    icon: _icon(notification.type),
                    title: NotificationCopy.title(notification),
                    body: NotificationCopy.body(notification),
                    timeLabel: NotificationCopy.relativeTime(
                      notification.createdAt,
                      now,
                    ),
                    isRead: notification.isRead,
                    onTap: () => unawaited(_open(context, ref, notification)),
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }

  /// Mark read → check the target → go there (where the destination checks
  /// again, as it does for any visit). Marking read never blocks the rest: a
  /// person who cannot reach the server still hears why they cannot go.
  static Future<void> _open(
    BuildContext context,
    WidgetRef ref,
    AppNotification notification,
  ) async {
    unawaited(
      ref
          .read(notificationListProvider.notifier)
          .markRead(notification)
          .catchError((Object _) {}),
    );
    final resolution = await ref
        .read(notificationTargetResolverProvider)
        .resolve(notification.target);
    if (!context.mounted) return;
    switch (resolution) {
      case OpenRoute(:final location):
        unawaited(context.push(location));
      case CannotOpen(:final message):
        _say(context, message);
    }
  }

  static IconData _icon(NotificationType type) => switch (type) {
    NotificationType.messageReceived => Icons.chat_bubble_outline_rounded,
    NotificationType.conversationCreated ||
    NotificationType.addedToConversation => Icons.forum_outlined,
    NotificationType.assignmentCreated ||
    NotificationType.assignmentUpdated => Icons.assignment_outlined,
    NotificationType.announcementCreated => Icons.campaign_outlined,
    NotificationType.certificateIssued => Icons.workspace_premium_outlined,
    NotificationType.halaqaUpdate => Icons.groups_2_outlined,
    NotificationType.unknown => Icons.notifications_none_rounded,
  };
}

/// The end of the list: more to load, loading, or a retry after a failure.
class _Footer extends ConsumerWidget {
  const _Footer({required this.state});

  final NotificationListState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!state.hasMore) return const SizedBox.shrink();
    if (state.loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: () => ref.read(notificationListProvider.notifier).loadMore(),
        child: Text(
          state.loadMoreFailed
              ? '${NotificationCopy.loadMoreFailed} ${NotificationCopy.retry}'
              : NotificationCopy.loadMore,
        ),
      ),
    );
  }
}

void _say(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}
