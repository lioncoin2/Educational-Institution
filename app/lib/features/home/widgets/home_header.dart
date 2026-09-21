import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';

/// The centered institution identity, with a notification bell and a profile
/// button in the corners — the reference's header composition.
///
/// The title and subtitle are the institution's own (profile pages 1 and 3);
/// there is no mock element here. The corner buttons render unconditionally so
/// navigation is available immediately after boot; the centred identity fades
/// in once [title] is available.
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
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Reference order (RTL): profile at the start (right), bell at the end
        // (left).
        IconButton(
          onPressed: onProfile,
          icon: const Icon(Icons.person_outline_rounded),
          tooltip: 'حسابي',
          style: IconButton.styleFrom(
            backgroundColor: context.colors.surfaceContainerHigh,
            minimumSize: const Size(48, 48),
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: Insets.xs),
            child: title == null
                ? const SizedBox(height: 48)
                : Column(
                    children: [
                      Text(
                        title!,
                        textAlign: TextAlign.center,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.titleLarge,
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: Insets.xs),
                        Wrap(
                          alignment: WrapAlignment.center,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          spacing: Insets.sm,
                          runSpacing: Insets.xs,
                          children: [
                            Text(
                              subtitle!,
                              textAlign: TextAlign.center,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: context.text.bodyMedium,
                            ),
                            const SourceChip(page: 3),
                          ],
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

/// The bell with an unread badge. Lifted from the old home_greeting into this
/// Home-scoped widget rather than shared, and re-tinted for a light header.
class _NotificationButton extends StatelessWidget {
  const _NotificationButton({required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // One actionable node: the label carries the count, and excludeSemantics
    // drops the IconButton's tooltip node and the decorative badge Text so the
    // count is never announced twice. Pointer taps still reach the IconButton's
    // InkWell (hit-testing is unaffected); the onTap here serves assistive tech.
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
              backgroundColor: context.colors.surfaceContainerHigh,
              minimumSize: const Size(48, 48),
            ),
          ),
          if (count > 0)
            PositionedDirectional(
              end: 4,
              top: 4,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                constraints: const BoxConstraints(minWidth: 18),
                decoration: BoxDecoration(
                  color: context.colors.error,
                  borderRadius: Radii.pill,
                  border: Border.all(color: context.colors.surface, width: 1.5),
                ),
                child: Text(
                  '$count',
                  textAlign: TextAlign.center,
                  style: context.text.labelSmall?.copyWith(
                    color: context.colors.onError,
                    fontWeight: FontWeight.w700,
                    fontSize: 10,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
