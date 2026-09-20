import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// The dark rounded badge that carries a figure — "30 جزء", "40 مجموعة",
/// "3 مستويات". Lifted conceptually from pages 7 and 10 of the profile.
class StatBadge extends StatelessWidget {
  const StatBadge({
    super.key,
    required this.label,
    this.icon,
    this.tone = StatBadgeTone.primary,
  });

  final String label;
  final IconData? icon;
  final StatBadgeTone tone;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (tone) {
      StatBadgeTone.primary => (
          context.colors.primary,
          context.colors.onPrimary,
        ),
      StatBadgeTone.soft => (
          context.colors.primaryContainer,
          context.colors.onPrimaryContainer,
        ),
      StatBadgeTone.success => (
          context.colors.tertiaryContainer,
          context.colors.onTertiaryContainer,
        ),
    };

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.md,
        vertical: Insets.sm,
      ),
      decoration: BoxDecoration(color: bg, borderRadius: Radii.brMd),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: fg),
            const SizedBox(width: Insets.xs),
          ],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.labelMedium
                  ?.copyWith(color: fg, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

enum StatBadgeTone { primary, soft, success }

/// A pill, as used for مجالات التعليم on page 5: white pill, coloured dot.
class AppPill extends StatelessWidget {
  const AppPill({super.key, required this.label, this.dotColor, this.onTap});

  final String label;
  final Color? dotColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: context.colors.surfaceContainerLowest,
      borderRadius: Radii.pill,
      child: InkWell(
        onTap: onTap,
        borderRadius: Radii.pill,
        child: Container(
          padding: const EdgeInsetsDirectional.only(
            start: Insets.lg,
            end: Insets.sm,
            top: Insets.sm,
            bottom: Insets.sm,
          ),
          decoration: BoxDecoration(
            borderRadius: Radii.pill,
            border: Border.all(color: context.colors.outlineVariant),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.labelLarge,
                ),
              ),
              const SizedBox(width: Insets.md),
              Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(
                  color: dotColor ?? context.colors.primary,
                  shape: BoxShape.circle,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
