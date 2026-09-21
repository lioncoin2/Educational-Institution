import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_tokens.dart';

/// One of the four decorative tile hues on the Home stats card. Unlike the
/// مساري palette (where the tint encodes provenance), these are purely
/// decorative — the reference uses four unrelated pastels for its stat tiles,
/// and every figure here is real, so the colours carry no meaning.
enum HomeTileTone { mint, sky, lavender, peach }

/// Resolved colours for one stat tile.
class HomeTileColors {
  const HomeTileColors({
    required this.background,
    required this.foreground,
    required this.iconChip,
  });

  final Color background;
  final Color foreground;
  final Color iconChip;
}

/// The institutional green, scoped to the Home screen only.
///
/// The reference blueprint is unmistakably green with multi-hue pastel tiles,
/// while the app's global theme is plum. Rather than edit the global theme
/// (which would recolour every other screen), Home wraps itself in this scoped
/// [ThemeData] — the same technique the مساري screen uses — placed *below* the
/// shared navigation shell, so the bottom-nav selected pill stays plum and no
/// other tab is touched.
///
/// The accent is [AppColors.accentGreen] `#006B4F`, sampled from the open book
/// in the institution's own emblem, so nothing is invented and nothing is added
/// to `app_colors.dart`. Contrast of every pairing is asserted in
/// `test/home_screen_test.dart`.
abstract final class HomePalette {
  static ThemeData themeOf(BuildContext context) {
    final base = Theme.of(context);
    final scheme = schemeOf(base.colorScheme);

    return base.copyWith(
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      // These component themes bake scheme colours in at construction time in
      // app_theme.dart, so a bare colorScheme override would leave them plum.
      dividerTheme: base.dividerTheme.copyWith(color: scheme.outlineVariant),
      progressIndicatorTheme: base.progressIndicatorTheme.copyWith(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHighest,
        circularTrackColor: scheme.surfaceContainerHighest,
      ),
      // The global TextButton floor is 44; the two "عرض جميع…" actions need 48.
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
        onPrimaryContainer: const Color(0xFF00382A),
        secondary: AppColors.successDark,
        onSecondary: Colors.white,
        surface: const Color(0xFFF7FBFA),
        surfaceContainerLowest: Colors.white,
        surfaceContainerLow: const Color(0xFFF0F6F4),
        surfaceContainer: const Color(0xFFEBF3F1),
        surfaceContainerHigh: const Color(0xFFE6F0ED),
        surfaceContainerHighest: const Color(0xFFD1E4DF),
        outline: const Color(0xFF8CBCB0),
        outlineVariant: const Color(0xFFCCE1DC),
      );

  static ColorScheme _dark(ColorScheme base) => base.copyWith(
        primary: AppColors.successDark, // #3FA27F
        onPrimary: const Color(0xFF00281D),
        primaryContainer: const Color(0xFF1C4A3B),
        onPrimaryContainer: const Color(0xFFCDEDE1),
        secondary: AppColors.successDark,
        surfaceContainerHighest: const Color(0xFF263D38),
        outline: const Color(0xFF294940),
        outlineVariant: const Color(0xFF233330),
      );

  /// Decorative tile tints. Every fg/bg pair is >= AA in both brightnesses
  /// (verified in `test/home_screen_test.dart`).
  static HomeTileColors tile(BuildContext context, HomeTileTone tone) =>
      tileFor(Theme.of(context).brightness, tone);

  /// Brightness-keyed variant so contrast can be asserted without a widget.
  static HomeTileColors tileFor(Brightness brightness, HomeTileTone tone) {
    final dark = brightness == Brightness.dark;
    return switch (tone) {
      HomeTileTone.mint => dark
          ? const HomeTileColors(
              background: Color(0xFF173A2E),
              foreground: Color(0xFFCDEDE1),
              iconChip: Color(0x29CDEDE1),
            )
          : const HomeTileColors(
              background: Color(0xFFE6F0ED),
              foreground: Color(0xFF006B4F),
              iconChip: Color(0x1F006B4F),
            ),
      HomeTileTone.sky => dark
          ? const HomeTileColors(
              background: Color(0xFF153245),
              foreground: Color(0xFFCFE3F2),
              iconChip: Color(0x29CFE3F2),
            )
          : const HomeTileColors(
              background: Color(0xFFE7F0F7),
              foreground: Color(0xFF1F5B8A),
              iconChip: Color(0x1F1F5B8A),
            ),
      HomeTileTone.lavender => dark
          ? const HomeTileColors(
              background: Color(0xFF2C2440),
              foreground: Color(0xFFE4D9F5),
              iconChip: Color(0x29E4D9F5),
            )
          : const HomeTileColors(
              background: Color(0xFFEFEAF7),
              foreground: Color(0xFF5B3B8A),
              iconChip: Color(0x1F5B3B8A),
            ),
      HomeTileTone.peach => dark
          ? const HomeTileColors(
              background: Color(0xFF3A2E12),
              foreground: Color(0xFFF6DFC0),
              iconChip: Color(0x29F6DFC0),
            )
          : const HomeTileColors(
              background: Color(0xFFFBF0E2),
              foreground: Color(0xFF8A5A00),
              iconChip: Color(0x1F8A5A00),
            ),
    };
  }
}
