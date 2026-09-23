import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';
import '../foundations/app_card.dart';

/// One notification in a list: what kind (icon), what it says, when, and
/// whether it is unread. Presentational only — the screen decides the words
/// (from the notification's keys) and what a tap does.
class NotificationTile extends StatelessWidget {
  const NotificationTile({
    super.key,
    required this.icon,
    required this.title,
    required this.body,
    required this.timeLabel,
    required this.isRead,
    this.onTap,
  });

  final IconData icon;
  final String title;
  final String body;
  final String timeLabel;
  final bool isRead;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      onTap: onTap,
      color: isRead
          ? context.colors.surfaceContainerLow
          : context.colors.surfaceContainerLowest,
      padding: const EdgeInsets.all(Insets.md),
      semanticLabel: isRead ? '$title. $body' : 'غير مقروء. $title. $body',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: isRead
                  ? context.colors.surfaceContainerHigh
                  : context.colors.primaryContainer,
              borderRadius: Radii.brMd,
            ),
            child: Icon(
              icon,
              size: 20,
              color: isRead
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
                        title,
                        style: context.text.titleSmall?.copyWith(
                          fontWeight: isRead
                              ? FontWeight.w500
                              : FontWeight.w700,
                        ),
                      ),
                    ),
                    if (!isRead)
                      Container(
                        key: const ValueKey('unread-dot'),
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
                Text(body, style: context.text.bodySmall),
                const SizedBox(height: Insets.sm),
                Text(timeLabel, style: context.text.labelSmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
