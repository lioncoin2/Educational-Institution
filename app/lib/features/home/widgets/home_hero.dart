import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../core/widgets/layout/contour_background.dart';
import '../../../core/widgets/layout/responsive_body.dart';

/// The full-bleed hero band: a personal greeting and the primary
/// continue-learning call to action.
///
/// The reference shows a photographic hero. There are no image assets in the
/// project and downloading one is out of scope, so this is a branded painted
/// placeholder — a solid institutional-green [ContourBand] with the emblem
/// motif — reproducing the hero *composition* (tall band, greeting block, pill
/// CTA). Swap the band for a real photo later without touching the layout.
class HomeHero extends StatelessWidget {
  const HomeHero({
    super.key,
    required this.greetingName,
    required this.supportingLine,
    required this.ctaLabel,
    required this.onCta,
  });

  /// studentProvider.name — a placeholder learner, hence the MockChip below.
  final String greetingName;

  /// e.g. "الناشئات · قسم تجويد متوسط".
  final String supportingLine;

  final String ctaLabel;
  final VoidCallback onCta;

  @override
  Widget build(BuildContext context) {
    final onBrand = context.colors.onPrimary;

    return ContourBand(
      background: context.colors.primary,
      lineColor: onBrand,
      opacity: 0.14,
      borderRadius: const BorderRadius.vertical(bottom: Radii.xl),
      padding: const EdgeInsets.only(top: Insets.xxl, bottom: Insets.xxl),
      child: ResponsiveBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Emblem motif standing in for the reference's hero imagery.
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: onBrand.withValues(alpha: 0.18),
                borderRadius: Radii.brMd,
              ),
              child: Icon(Icons.menu_book_rounded, size: 24, color: onBrand),
            ),
            const SizedBox(height: Insets.lg),
            // Bare headline: never shares a main axis with the CTA, so a long
            // name at large text scale cannot force an overflow.
            Semantics(
              header: true,
              child: Text(
                'أهلاً، $greetingName',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.text.headlineLarge?.copyWith(color: onBrand),
              ),
            ),
            const SizedBox(height: Insets.md),
            Wrap(
              spacing: Insets.sm,
              runSpacing: Insets.sm,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  supportingLine,
                  style: context.text.bodyMedium?.copyWith(color: onBrand),
                ),
                const MockChip(compact: true),
              ],
            ),
            const SizedBox(height: Insets.xl),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: onCta,
                style: FilledButton.styleFrom(
                  backgroundColor: onBrand,
                  foregroundColor: context.colors.primary,
                ),
                icon: const Icon(Icons.play_arrow_rounded),
                label: Text(
                  ctaLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
