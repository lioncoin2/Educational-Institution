import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/unread_badge.dart';

/// The centered institution identity with a notification bell and a profile
/// button in the corners — the reference's header composition.
///
/// The title and subtitle are the institution's own (`shortName` and
/// `mission`); there is no mock or invented content here. The corner buttons
/// render unconditionally so navigation is available immediately after boot;
/// the centred identity fades in once [title] is available.
class HomeHeader extends StatelessWidget {
  const HomeHeader({
    super.key,
    required this.title,
    required this.subtitle,
    required this.unreadCount,
    required this.onNotifications,
    required this.onProfile,
  });

  /// institution.shortName — null while loading.
  final String? title;

  /// institution.mission — null while loading.
  final String? subtitle;

  final int unreadCount;
  final VoidCallback onNotifications;
  final VoidCallback onProfile;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        // Reference order (RTL): profile at the start (right), bell at the end
        // (left).
        _CircleButton(
          icon: Icons.person_outline_rounded,
          tooltip: 'حسابي',
          onTap: onProfile,
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Insets.sm),
            child: title == null
                ? const SizedBox(height: 48)
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title!,
                        textAlign: TextAlign.center,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.titleMedium?.copyWith(
                          color: context.colors.primary,
                          fontWeight: FontWeight.w800,
                          height: 1.2,
                        ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle!,
                          textAlign: TextAlign.center,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: context.text.bodySmall?.copyWith(
                            color: context.colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ],
                  ),
          ),
        ),
        _NotificationButton(count: unreadCount, onTap: onNotifications),
      ],
    );
  }
}

/// A white circular icon button with the soft card shadow — the reference's
/// header affordance.
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

/// The bell with its unread count (0: none, 1–99, then "99+"). One
/// actionable semantics node: the label carries the count, and
/// excludeSemantics drops the decorative badge and the button's tooltip node
/// so nothing is announced twice. Pointer taps still reach the InkWell; the
/// onTap here serves assistive tech.
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
      label: count <= 0
          ? 'الإشعارات'
          : count > 99
          ? 'الإشعارات، أكثر من 99 غير مقروءة'
          : 'الإشعارات، $count غير مقروءة',
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
              end: 2,
              top: 2,
              child: UnreadBadge(count: count),
            ),
        ],
      ),
    );
  }
}
