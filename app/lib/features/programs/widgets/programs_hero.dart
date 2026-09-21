import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';

/// The reference's short program-hero banner: the mosque photo on the left, a
/// light panel with the institution's own line on the right.
///
/// Both text lines are real institution content (from the profile's "about").
/// The photo reuses the existing `assets/images/hero_mosque.jpg` asset. It is a
/// banner strip, sized to its content — not a full-screen hero.
class ProgramsHero extends StatelessWidget {
  const ProgramsHero({super.key, required this.headline, required this.support});

  final String headline;
  final String support;

  static const _asset = 'assets/images/hero_mosque.jpg';

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: Radii.brLg,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Text panel — first child, so it sits on the right (start) in RTL.
            Expanded(
              flex: 60,
              child: ColoredBox(
                color: context.colors.surfaceContainerLow,
                child: Padding(
                  padding: const EdgeInsets.all(Insets.lg),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        headline,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.titleLarge?.copyWith(
                          color: context.colors.primary,
                          fontWeight: FontWeight.w800,
                          height: 1.2,
                        ),
                      ),
                      const SizedBox(height: Insets.sm),
                      Text(
                        support,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodySmall
                            ?.copyWith(color: context.colors.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // Photo — last child, so it sits on the left (end) in RTL.
            Expanded(
              flex: 40,
              child: Image.asset(
                _asset,
                fit: BoxFit.cover,
                errorBuilder: (context, error, stack) =>
                    ColoredBox(color: context.colors.primaryContainer),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
