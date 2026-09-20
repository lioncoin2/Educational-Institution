import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/patterns/notification_tile.dart';
import '../../providers/app_providers.dart';

/// In-app notification list. Nothing is pushed — there is no notification
/// service in this prototype; tapping only flips a local read flag.
class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifications = ref.watch(notificationsProvider);
    final unread = ref.watch(unreadNotificationCountProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('الإشعارات'),
        actions: [
          // An icon rather than a text button: at the largest text scale the
          // Arabic label plus the title no longer fits a 360pt app bar.
          if (unread > 0)
            IconButton(
              tooltip: 'تحديد الكل كمقروء',
              onPressed: () =>
                  ref.read(notificationsProvider.notifier).markAllRead(),
              icon: const Icon(Icons.done_all_rounded),
            ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: notifications,
          loading: const Center(child: CircularProgressIndicator()),
          builder: (context, list) {
            if (list.isEmpty) {
              return const EmptyState(
                icon: Icons.notifications_off_outlined,
                title: 'لا توجد إشعارات',
              );
            }
            return CustomScrollView(
              slivers: [
                SliverGutter(
                  child: const MockBanner(
                    message:
                        'إشعارات تجريبية داخل التطبيق فقط. لا يوجد إرسال '
                        'إشعارات فعلي في هذه المرحلة.',
                  ),
                ),
                SliverGutter(
                  top: Insets.lg,
                  bottom: Insets.giant,
                  child: Column(
                    children: [
                      for (final notification in list)
                        Padding(
                          padding: const EdgeInsets.only(bottom: Insets.md),
                          child: NotificationTile(
                            notification: notification,
                            onTap: () => ref
                                .read(notificationsProvider.notifier)
                                .markRead(notification.id),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
