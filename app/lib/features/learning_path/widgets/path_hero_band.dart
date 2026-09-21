import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../core/widgets/layout/contour_background.dart';
import '../../../core/widgets/layout/responsive_body.dart';

/// The full-bleed green header of the مساري screen.
///
/// Deliberately has no Row at the top: the headline is a bare [Text], so a
/// 32pt title at text scale 1.3 never has to share a main axis with a button.
/// The screen's secondary affordance lives in the section header further down.
class PathHeroBand extends StatelessWidget {
  const PathHeroBand({super.key, required this.onContinue});

  /// Null when there is no current department to continue into; the call to
  /// action is then omitted rather than disabled.
  final VoidCallback? onContinue;

  @override
  Widget build(BuildContext context) {
    final onBrand = context.colors.onPrimary;

    return ContourBand(
      background: context.colors.primary,
      // ContourPainter re-applies alpha from `opacity`, so the colour passed
      // here must stay opaque or the fade is silently dropped.
      lineColor: onBrand,
      opacity: 0.14,
      borderRadius: const BorderRadius.vertical(bottom: Radii.xl),
      padding: const EdgeInsets.only(top: Insets.xxl, bottom: Insets.xxl),
      child: ResponsiveBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: Text(
                'مساري',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.text.headlineLarge?.copyWith(color: onBrand),
              ),
            ),
            const SizedBox(height: Insets.md),
            // Wrap, not Row: the line plus its provenance chip need a second
            // run on a narrow screen at the largest text scale.
            Wrap(
              spacing: Insets.sm,
              runSpacing: Insets.sm,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  'الأقسام الخمسة كما وردت في الملف التعريفي',
                  style: context.text.bodyMedium?.copyWith(color: onBrand),
                ),
                const SourceChip(page: 6),
              ],
            ),
            if (onContinue != null) ...[
              const SizedBox(height: Insets.xl),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: onContinue,
                  style: FilledButton.styleFrom(
                    backgroundColor: onBrand,
                    foregroundColor: context.colors.primary,
                  ),
                  icon: const Icon(Icons.play_arrow_rounded),
                  label: const Text(
                    'تابعي مسارك',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
