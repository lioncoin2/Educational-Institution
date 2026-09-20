import 'package:flutter/material.dart';

import '../../../data/models/feed.dart';
import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';
import '../foundations/app_card.dart';

class NotificationTile extends StatelessWidget {
  const NotificationTile({
    super.key,
    required this.notification,
    this.onTap,
  });

  final AppNotification notification;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final icon = switch (notification.kind) {
      NotificationKind.halaqa => Icons.groups_2_outlined,
      NotificationKind.lesson => Icons.play_lesson_outlined,
      NotificationKind.certificate => Icons.workspace_premium_outlined,
      NotificationKind.announcement => Icons.campaign_outlined,
    };

    return AppCard(
      onTap: onTap,
      color: notification.isRead
          ? context.colors.surfaceContainerLow
          : context.colors.surfaceContainerLowest,
      padding: const EdgeInsets.all(Insets.md),
      semanticLabel: notification.title,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: notification.isRead
                  ? context.colors.surfaceContainerHigh
                  : context.colors.primaryContainer,
              borderRadius: Radii.brMd,
            ),
            child: Icon(
              icon,
              size: 20,
              color: notification.isRead
                  ? context.colors.onSurfaceVariant
                  : context.colors.onPrimaryContainer,
            ),
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        notification.title,
                        style: context.text.titleSmall?.copyWith(
                          fontWeight: notification.isRead
                              ? FontWeight.w500
                              : FontWeight.w700,
                        ),
                      ),
                    ),
                    if (!notification.isRead)
                      Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: context.colors.primary,
                          shape: BoxShape.circle,
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: Insets.xs),
                Text(notification.body, style: context.text.bodySmall),
                const SizedBox(height: Insets.sm),
                Text(notification.timeLabel, style: context.text.labelSmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
