import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/layout/responsive_body.dart';
import 'home_hero_backdrop.dart';

/// The full-bleed hero: a painted golden-hour mosque, an institutional welcome
/// on the right (RTL start), and the primary call to action — reproducing the
/// reference's hero composition.
///
/// Every line of copy is institutional: the welcome is standard UI text and the
/// slogan is the institution's own mission (`institution.mission`). No learner
/// data and no invented figures appear here, so there is no mock marker.
class HomeHero extends StatelessWidget {
  const HomeHero({
    super.key,
    required this.headline,
    required this.subhead,
    required this.slogan,
    required this.ctaLabel,
    required this.onCta,
  });

  /// e.g. "مرحباً بك".
  final String headline;

  /// e.g. "في رحلتك مع القرآن الكريم".
  final String subhead;

  /// The institution's real mission line, e.g. "التعليم والدعوة والتربية".
  final String slogan;

  final String ctaLabel;
  final VoidCallback onCta;

  // The painted backdrop is a light, warm scene in BOTH themes (like a photo,
  // it does not invert for dark mode), so the hero copy uses fixed dark inks
  // rather than theme colours that would flip to light and vanish over it.
  static const _ink = Color(0xFF0A5741); // dark emerald — the brand green
  static const _inkBody = Color(0xFF262019); // near-black warm
  static const _inkMuted = Color(0xFF5A5148); // warm grey
  static const _ctaBg = Color(0xFF00674B); // institutional green (fixed)

  @override
  Widget build(BuildContext context) {
    final minHeight =
        (MediaQuery.sizeOf(context).height * 0.42).clamp(320.0, 460.0);

    return ClipRRect(
      borderRadius: const BorderRadius.vertical(bottom: Radii.xl),
      child: Stack(
        children: [
          const Positioned.fill(child: HomeHeroBackdrop()),
          // A directional light scrim over the text side (RTL start = right)
          // so the dark copy always clears contrast over the warm sky.
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: AlignmentDirectional.topStart,
                  end: AlignmentDirectional.bottomEnd,
                  colors: [
                    Colors.white.withValues(alpha: 0.62),
                    Colors.white.withValues(alpha: 0.0),
                  ],
                  stops: const [0.0, 0.62],
                ),
              ),
            ),
          ),
          ConstrainedBox(
            constraints: BoxConstraints(minHeight: minHeight),
            child: ResponsiveBody(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: Insets.xxl),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(
                        headline,
                        style: context.text.headlineLarge?.copyWith(
                          color: _ink,
                          fontWeight: FontWeight.w800,
                          height: 1.15,
                        ),
                      ),
                    ),
                    const SizedBox(height: Insets.sm),
                    Text(
                      subhead,
                      style: context.text.titleLarge?.copyWith(
                        color: _inkBody,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: Insets.sm),
                    Text(
                      slogan,
                      style: context.text.bodyMedium?.copyWith(color: _inkMuted),
                    ),
                    const SizedBox(height: Insets.xl),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: FilledButton(
                        onPressed: onCta,
                        style: FilledButton.styleFrom(
                          backgroundColor: _ctaBg,
                          foregroundColor: Colors.white,
                          minimumSize: const Size(0, 48),
                          padding: const EdgeInsets.symmetric(
                            horizontal: Insets.xl,
                            vertical: Insets.md,
                          ),
                          textStyle: context.text.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        // Icon first → sits at the start (right) under RTL, as in
                        // the reference; the Flexible label ellipsises so the
                        // button never overflows at large text scales.
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.menu_book_rounded, size: 20),
                            const SizedBox(width: Insets.sm),
                            Flexible(
                              child: Text(
                                ctaLabel,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
