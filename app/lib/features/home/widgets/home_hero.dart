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

  // The photographic backdrop is a light, warm scene in BOTH themes (a photo
  // does not invert for dark mode), so the hero copy uses fixed dark inks rather
  // than theme colours that would flip to light and vanish over it. The inks are
  // near-black so they clear AA over the veiled photo at every text scale.
  static const _ink = Color(0xFF0A5741); // dark emerald — the brand green
  static const _inkBody = Color(0xFF1E1A15); // near-black warm
  static const _inkMuted = Color(0xFF352F28); // dark warm grey
  static const _ctaBg = Color(0xFF00674B); // institutional green (fixed)

  @override
  Widget build(BuildContext context) {
    // Reference geometry: the hero is ~0.536 of the screen width tall
    // (≈380/709). Driven by width, not height, and clamped so it stays a banner
    // on wide screens; the ConstrainedBox lets it grow if the copy needs more
    // room at large text scales, so it never overflows.
    final minHeight =
        (MediaQuery.sizeOf(context).width * 0.536).clamp(190.0, 380.0);

    return ClipRRect(
      borderRadius: const BorderRadius.vertical(bottom: Radii.xl),
      // ConstrainedBox wraps the whole Stack (not just the copy) and the Stack
      // centres its non-positioned child, so the copy sits in the hero's
      // vertical middle instead of being pinned to the top.
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: minHeight),
        child: Stack(
          alignment: Alignment.center,
          children: [
            const Positioned.fill(child: HomeHeroBackdrop()),
            // A flat light veil across the text side (RTL start = right) so the
            // copy keeps AA contrast over any region of the photo, then fading
            // out over the mosque on the left.
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: AlignmentDirectional.centerStart,
                    end: AlignmentDirectional.centerEnd,
                    colors: [
                      Colors.white.withValues(alpha: 0.60),
                      Colors.white.withValues(alpha: 0.60),
                      Colors.white.withValues(alpha: 0.0),
                    ],
                    stops: const [0.0, 0.52, 0.9],
                  ),
                ),
              ),
            ),
            ResponsiveBody(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: Insets.lg),
                // Confine the copy to the right ~60% (over the bright sky), with
                // the mosque showing through the empty end (left) — the
                // reference's hero composition.
                child: Row(
                  children: [
                    Expanded(
                      flex: 60,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Semantics(
                            header: true,
                            child: Text(
                              headline,
                              style: context.text.headlineLarge?.copyWith(
                                color: _ink,
                                fontWeight: FontWeight.w800,
                                height: 1.1,
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
                          const SizedBox(height: Insets.xs),
                          Text(
                            slogan,
                            style: context.text.bodyMedium
                                ?.copyWith(color: _inkMuted),
                          ),
                          const SizedBox(height: Insets.lg),
                          Align(
                            alignment: AlignmentDirectional.centerStart,
                            child: FilledButton(
                              onPressed: onCta,
                              style: FilledButton.styleFrom(
                                backgroundColor: _ctaBg,
                                foregroundColor: Colors.white,
                                minimumSize: const Size(0, 48),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: Insets.lg,
                                  vertical: Insets.md,
                                ),
                                textStyle: context.text.titleSmall
                                    ?.copyWith(fontWeight: FontWeight.w700),
                              ),
                              // Icon first → sits at the start (right) under RTL,
                              // as in the reference; the Flexible label ellipsises
                              // so the button never overflows at large scales.
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
                    const Spacer(flex: 40),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
