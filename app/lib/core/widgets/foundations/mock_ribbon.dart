import 'package:flutter/material.dart';

import '../../../app/app_config.dart';
import '../../extensions/context_ext.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_tokens.dart';

/// Small amber chip meaning "this number/name was invented for the prototype".
///
/// Amber is deliberately outside the institution's plum palette so it can
/// never read as part of the brand.
class MockChip extends StatelessWidget {
  const MockChip({super.key, this.label = 'بيانات تجريبية', this.compact = false});

  final String label;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    if (!AppConfig.showMockRibbons) return const SizedBox.shrink();
    final bg = context.isDark ? AppColors.mockAmberBgDark : AppColors.mockAmberBg;
    final fg = context.isDark ? AppColors.warningDark : AppColors.mockAmber;

    return Semantics(
      label: 'بيانات تجريبية غير مأخوذة من الملف التعريفي',
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: compact ? Insets.sm : Insets.md,
          vertical: compact ? 2 : Insets.xs,
        ),
        decoration: BoxDecoration(color: bg, borderRadius: Radii.pill),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.science_outlined, size: compact ? 12 : 14, color: fg),
            const SizedBox(width: Insets.xs),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: (compact
                        ? context.text.labelSmall
                        : context.text.labelMedium)
                    ?.copyWith(color: fg, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Full-width banner for screens whose entire content is placeholder.
class MockBanner extends StatelessWidget {
  const MockBanner({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    if (!AppConfig.showMockRibbons) return const SizedBox.shrink();
    final bg = context.isDark ? AppColors.mockAmberBgDark : AppColors.mockAmberBg;
    final fg = context.isDark ? AppColors.warningDark : AppColors.mockAmber;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(Insets.md),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: Radii.brMd,
        border: Border.all(color: fg.withValues(alpha: 0.28)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.science_outlined, size: 18, color: fg),
          const SizedBox(width: Insets.sm),
          Expanded(
            child: Text(
              message,
              style: context.text.bodySmall?.copyWith(color: fg, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}

/// Marks content that IS taken from the institution profile, with its page.
class SourceChip extends StatelessWidget {
  const SourceChip({super.key, required this.page});

  final int page;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.sm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: context.colors.tertiaryContainer,
        borderRadius: Radii.pill,
      ),
      child: Text(
        'الملف التعريفي · ص$page',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: context.text.labelSmall?.copyWith(
          color: context.colors.onTertiaryContainer,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
