import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';

/// The centered Programs identity with a notification bell and a profile button
/// in the corners — the reference's header composition.
///
/// [title] is the generic screen label "البرامج التعليمية"; [subtitle] is the
/// institution's own line. Mirrors the Home header intentionally rather than
/// sharing it, to keep each feature's chrome self-contained.
class ProgramsHeader extends StatelessWidget {
  const ProgramsHeader({
    super.key,
    required this.title,
    required this.subtitle,
    required this.unreadCount,
    required this.onNotifications,
    required this.onProfile,
  });

  final String title;
  final String subtitle;
  final int unreadCount;
  final VoidCallback onNotifications;
  final VoidCallback onProfile;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        _CircleButton(
          icon: Icons.person_outline_rounded,
          tooltip: 'حسابي',
          onTap: onProfile,
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Insets.sm),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.titleMedium?.copyWith(
                    color: context.colors.primary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.bodySmall
                      ?.copyWith(color: context.colors.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
        _NotificationButton(count: unreadCount, onTap: onNotifications),
      ],
    );
  }
}

class _CircleButton extends StatelessWidget {
  const _CircleButton({
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: onTap,
      icon: Icon(icon),
      tooltip: tooltip,
      style: IconButton.styleFrom(
        backgroundColor: context.colors.surfaceContainerLowest,
        foregroundColor: context.colors.primary,
        minimumSize: const Size(48, 48),
        shape: const CircleBorder(),
        elevation: context.isDark ? 0 : 2,
        shadowColor: const Color(0x22000000),
      ),
    );
  }
}

/// The bell with a small unread dot. One actionable semantics node: the label
/// carries the count and excludeSemantics drops the decorative dot and tooltip.
class _NotificationButton extends StatelessWidget {
  const _NotificationButton({required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      button: true,
      excludeSemantics: true,
      onTap: onTap,
      label: count > 0 ? 'الإشعارات، $count غير مقروءة' : 'الإشعارات',
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          IconButton(
            onPressed: onTap,
            icon: const Icon(Icons.notifications_none_rounded),
            tooltip: 'الإشعارات',
            style: IconButton.styleFrom(
              backgroundColor: context.colors.surfaceContainerLowest,
              foregroundColor: context.colors.primary,
              minimumSize: const Size(48, 48),
              shape: const CircleBorder(),
              elevation: context.isDark ? 0 : 2,
              shadowColor: const Color(0x22000000),
            ),
          ),
          if (count > 0)
            PositionedDirectional(
              end: 8,
              top: 8,
              child: Container(
                width: 11,
                height: 11,
                decoration: BoxDecoration(
                  color: context.colors.error,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: context.colors.surfaceContainerLowest,
                    width: 1.5,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
