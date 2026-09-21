import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_tokens.dart';

/// Which provenance a stat tile carries. The tint itself encodes it, so the
/// reader can tell profile-sourced figures from prototype ones at a glance.
enum PathTileTone { profile, mock }

/// Resolved colours for one stat tile.
class PathTileColors {
  const PathTileColors({
    required this.background,
    required this.foreground,
    required this.iconChip,
  });

  final Color background;
  final Color foreground;
  final Color iconChip;
}

/// The institutional green, scoped to the مساري screen only.
///
/// The accent is [AppColors.accentGreen] — already in the codebase, sampled
/// from the open book in the institution's emblem. Nothing is added to
/// `app_colors.dart` and nothing in `app_theme.dart` is edited: this palette is
/// applied by a single [Theme] wrapper inside `LearningPathScreen`, which sits
/// *below* the shared navigation shell, so the global plum survives on every
/// other tab.
///
/// Every shade below is a blend of the emblem green over the base surface, so
/// no new brand colour is invented. Contrast of each pairing was measured with
/// the same WCAG formula `test/widget_test.dart` uses; the values are noted
/// inline and asserted in `test/learning_path_screen_test.dart`.
abstract final class PathPalette {
  /// Wraps the ambient theme in the scoped green scheme.
  static ThemeData themeOf(BuildContext context) {
    final base = Theme.of(context);
    final scheme = schemeOf(base.colorScheme);

    return base.copyWith(
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,

      // These three component themes bake scheme colours in at construction
      // time in app_theme.dart, so a bare `colorScheme:` override would leave
      // them plum. Everything else resolves its colour at paint time.
      dividerTheme: base.dividerTheme.copyWith(color: scheme.outlineVariant),
      progressIndicatorTheme: base.progressIndicatorTheme.copyWith(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHighest,
        circularTrackColor: scheme.surfaceContainerHighest,
      ),
      // The global TextButton minimum is 44; this screen holds it to the 48dp
      // accessibility floor.
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 48),
          shape: const RoundedRectangleBorder(borderRadius: Radii.brMd),
          textStyle: base.textTheme.labelLarge,
        ),
      ),
    );
  }

  static ColorScheme schemeOf(ColorScheme base) =>
      base.brightness == Brightness.dark ? _dark(base) : _light(base);

  static ColorScheme _light(ColorScheme base) => base.copyWith(
        primary: AppColors.accentGreen, // #006B4F — 6.53:1 on white
        onPrimary: Colors.white,
        primaryContainer: const Color(0xFFC7DED8),
        onPrimaryContainer: const Color(0xFF00382A), // 9.30:1
        secondary: AppColors.successDark,
        onSecondary: Colors.white,
        surface: const Color(0xFFF7FBFA), // the clean light background
        surfaceContainerLowest: Colors.white,
        surfaceContainerLow: const Color(0xFFF0F6F4),
        surfaceContainer: const Color(0xFFEBF3F1),
        surfaceContainerHigh: const Color(0xFFE6F0ED),
        // Progress tracks: the green arc reads 4.94:1 against this, well over
        // the 3:1 floor for non-text contrast.
        surfaceContainerHighest: const Color(0xFFD1E4DF),
        outline: const Color(0xFF8CBCB0),
        outlineVariant: const Color(0xFFCCE1DC),
      );

  static ColorScheme _dark(ColorScheme base) => base.copyWith(
        primary: AppColors.successDark, // #3FA27F
        onPrimary: const Color(0xFF00281D), // 5.06:1
        primaryContainer: const Color(0xFF1C4A3B),
        onPrimaryContainer: const Color(0xFFCDEDE1), // 8.03:1
        secondary: AppColors.successDark,
        surfaceContainerHighest: const Color(0xFF263D38),
        outline: const Color(0xFF294940),
        outlineVariant: const Color(0xFF233330),
      );

  /// Tile tints. `profile` is a green blend; `mock` deliberately borrows the
  /// honesty system's own amber rather than a decorative pastel, so provenance
  /// is never mistaken for brand colour.
  static PathTileColors tile(BuildContext context, PathTileTone tone) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return switch (tone) {
      PathTileTone.profile => dark
          ? const PathTileColors(
              background: Color(0xFF1C4A3B),
              foreground: Color(0xFFCDEDE1), // 8.03:1
              iconChip: Color(0x29CDEDE1),
            )
          : const PathTileColors(
              background: Color(0xFFE6F0ED),
              foreground: AppColors.accentGreen, // 5.61:1
              iconChip: Color(0x1F006B4F),
            ),
      PathTileTone.mock => dark
          ? const PathTileColors(
              background: AppColors.mockAmberBgDark,
              foreground: AppColors.warningDark, // 5.65:1
              iconChip: Color(0x29E09B3D),
            )
          : const PathTileColors(
              background: AppColors.mockAmberBg,
              foreground: AppColors.mockAmber, // 5.06:1
              iconChip: Color(0x1F8A6100),
            ),
    };
  }
}
