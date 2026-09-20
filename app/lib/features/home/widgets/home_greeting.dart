import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../core/widgets/layout/contour_background.dart';
import '../../../core/widgets/layout/responsive_body.dart';
import '../../../data/models/student.dart';

/// Plum header band with contour lines — the app's most brand-forward surface.
class HomeGreeting extends StatelessWidget {
  const HomeGreeting({
    super.key,
    required this.student,
    required this.unreadCount,
    required this.onNotifications,
  });

  final StudentProfile student;
  final int unreadCount;
  final VoidCallback onNotifications;

  @override
  Widget build(BuildContext context) {
    final onBrand = context.colors.onPrimary;

    return ContourBand(
      background: context.colors.primary,
      lineColor: onBrand,
      opacity: 0.14,
      borderRadius: const BorderRadius.vertical(bottom: Radii.xl),
      padding: const EdgeInsets.only(
        top: Insets.xl,
        bottom: Insets.xxl,
      ),
      child: ResponsiveBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 24,
                  backgroundColor: onBrand.withValues(alpha: 0.18),
                  child: Text(
                    student.initials,
                    style: context.text.titleLarge?.copyWith(color: onBrand),
                  ),
                ),
                const SizedBox(width: Insets.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'أهلاً ${student.name}',
                        style:
                            context.text.titleLarge?.copyWith(color: onBrand),
                      ),
                      Text(
                        student.currentProgramName,
                        style: context.text.bodySmall
                            ?.copyWith(color: onBrand.withValues(alpha: 0.78)),
                      ),
                    ],
                  ),
                ),
                _NotificationButton(
                  count: unreadCount,
                  onTap: onNotifications,
                  onBrand: onBrand,
                ),
              ],
            ),
            const SizedBox(height: Insets.lg),
            const MockChip(label: 'ملف طالبة تجريبي', compact: true),
          ],
        ),
      ),
    );
  }
}

class _NotificationButton extends StatelessWidget {
  const _NotificationButton({
    required this.count,
    required this.onTap,
    required this.onBrand,
  });

  final int count;
  final VoidCallback onTap;
  final Color onBrand;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: count > 0 ? 'الإشعارات، $count غير مقروءة' : 'الإشعارات',
      button: true,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          IconButton(
            onPressed: onTap,
            icon: const Icon(Icons.notifications_none_rounded),
            color: onBrand,
            style: IconButton.styleFrom(
              backgroundColor: onBrand.withValues(alpha: 0.18),
            ),
            tooltip: 'الإشعارات',
          ),
          if (count > 0)
            PositionedDirectional(
              end: 2,
              top: 2,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                constraints: const BoxConstraints(minWidth: 18),
                decoration: BoxDecoration(
                  color: context.colors.error,
                  borderRadius: Radii.pill,
                  border: Border.all(color: context.colors.primary, width: 1.5),
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
