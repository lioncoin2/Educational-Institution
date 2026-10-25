import 'package:flutter/material.dart';

import 'app_tokens.dart';
import 'app_typography.dart';

/// The immersive, always-dark palette for the **live-broadcast surface** — the
/// in-app live session screen (its stage, controls, roster and states) and
/// nothing else.
///
/// Unlike [MessagingPalette]/`HomePalette`, which follow the ambient
/// brightness, the live surface is deliberately ALWAYS dark: a broadcast stage
/// reads as a focused, cinema-like space whatever mode the rest of the app is
/// in, matching the reference design (a dark stage with an "on-air" accent). It
/// is applied BELOW the navigation shell, inside `LiveSessionScreen`, via
/// `Theme(data: LivePalette.themeOf(context), …)`, so the plum/green navigation
/// and every other surface are untouched.
///
/// The global and messaging themes bake some scheme colours in at construction,
/// so — exactly as [MessagingPalette] does — the component themes that appear on
/// the live surface are re-themed here; everything else resolves its colour at
/// paint time and follows the dark scheme automatically. There are no scheme
/// colours hard-coded per widget: the stage tokens below are the only literals,
/// and they exist because "on-air" is a signal distinct from both the brand
/// green ([ColorScheme.primary]) and destructive red ([ColorScheme.error]).
abstract final class LivePalette {
  // ── Stage tokens (used directly by the stage widget, nowhere else) ─────────
  /// The two stops of the broadcast stage's background (top → bottom).
  static const Color stageTop = Color(0xFF14222D);
  static const Color stageBottom = Color(0xFF0A1016);

  /// The "on-air" accent — the live pill and indicator dot. A warm red, the
  /// universal live-broadcast signal; white on it clears AA (~4.8:1).
  static const Color onAir = Color(0xFFD9363C);
  static const Color onOnAir = Colors.white;

  /// A translucent scrim for controls laid directly over the stage.
  static const Color scrim = Color(0x730A1016);

  /// Wraps the ambient theme in the fixed dark, immersive live scheme.
  static ThemeData themeOf(BuildContext context) {
    final base = Theme.of(context);
    const scheme = _scheme;
    final text = AppTypography.textTheme(
      scheme.onSurface,
      scheme.onSurfaceVariant,
    );

    return base.copyWith(
      brightness: Brightness.dark,
      colorScheme: scheme,
      textTheme: text,
      primaryTextTheme: text,
      scaffoldBackgroundColor: scheme.surface,
      canvasColor: scheme.surface,
      dividerColor: scheme.outlineVariant,
      iconTheme: IconThemeData(color: scheme.onSurface),
      dividerTheme: base.dividerTheme.copyWith(color: scheme.outlineVariant),
      appBarTheme: base.appBarTheme.copyWith(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        foregroundColor: scheme.onSurface,
        iconTheme: IconThemeData(color: scheme.onSurface),
        titleTextStyle: text.titleLarge,
      ),
      progressIndicatorTheme: base.progressIndicatorTheme.copyWith(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHighest,
        circularTrackColor: scheme.surfaceContainerHighest,
      ),
      // Buttons bake scheme colours at construction (see app_theme.dart), so
      // the ones that appear on the live surface are re-themed for dark here.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: Insets.xxl),
          shape: const RoundedRectangleBorder(borderRadius: Radii.pill),
          backgroundColor: scheme.primary,
          foregroundColor: scheme.onPrimary,
          textStyle: text.labelLarge,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: Insets.xxl),
          shape: const RoundedRectangleBorder(borderRadius: Radii.pill),
          side: BorderSide(color: scheme.outline),
          foregroundColor: scheme.onSurface,
          textStyle: text.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 44),
          shape: const RoundedRectangleBorder(borderRadius: Radii.brMd),
          foregroundColor: scheme.primary,
          textStyle: text.labelLarge,
        ),
      ),
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: scheme.surfaceContainerHigh,
        selectedColor: scheme.secondaryContainer,
        secondarySelectedColor: scheme.secondaryContainer,
        side: BorderSide(color: scheme.outlineVariant),
        labelStyle: text.labelMedium,
      ),
      // Toasts, the roster filter menu and the confirm dialogs all surface over
      // the dark stage; keep them legible on their own dark container.
      snackBarTheme: base.snackBarTheme.copyWith(
        backgroundColor: scheme.surfaceContainerHighest,
        contentTextStyle: text.bodyMedium?.copyWith(color: scheme.onSurface),
      ),
      popupMenuTheme: base.popupMenuTheme.copyWith(
        color: scheme.surfaceContainerHigh,
        surfaceTintColor: Colors.transparent,
        textStyle: text.bodyMedium?.copyWith(color: scheme.onSurface),
      ),
      dialogTheme: base.dialogTheme.copyWith(
        backgroundColor: scheme.surfaceContainerHigh,
        surfaceTintColor: Colors.transparent,
      ),
    );
  }

  /// The fixed dark, immersive live scheme. Values are chosen for AA contrast on
  /// the dark surfaces (onSurface ~15:1, onSurfaceVariant ~7:1, primary as an
  /// accent/icon colour). Field set mirrors `AppTheme.dark`.
  static const ColorScheme _scheme = ColorScheme(
    brightness: Brightness.dark,
    primary: Color(0xFF36D39E), // brand green, brightened for the dark stage
    onPrimary: Color(0xFF00281C),
    primaryContainer: Color(0xFF0E3D2E),
    onPrimaryContainer: Color(0xFFBFEEDD),
    secondary: Color(0xFF8FB8FF), // a cool, non-"live" accent
    onSecondary: Color(0xFF07213F),
    secondaryContainer: Color(0xFF17362E), // presenter badge surface (greenish)
    onSecondaryContainer: Color(0xFFBFEEDD),
    tertiary: Color(0xFF7FD1FF),
    onTertiary: Color(0xFF00344C),
    tertiaryContainer: Color(0xFF0E3A4D),
    onTertiaryContainer: Color(0xFFC7EBFF),
    error: Color(0xFFFF8A8A),
    onError: Color(0xFF450A0A),
    errorContainer: Color(0xFF5C1A1C),
    onErrorContainer: Color(0xFFFFD9D9),
    surface: Color(0xFF0D141A),
    onSurface: Color(0xFFEAEEF2),
    surfaceContainerLowest: Color(0xFF080E13),
    surfaceContainerLow: Color(0xFF111A21),
    surfaceContainer: Color(0xFF15212A),
    surfaceContainerHigh: Color(0xFF1B2832),
    surfaceContainerHighest: Color(0xFF26343E),
    onSurfaceVariant: Color(0xFFA7B4BD),
    outline: Color(0xFF3A4852),
    outlineVariant: Color(0xFF212D35),
    shadow: Color(0xFF000000),
    scrim: Color(0xCC05090D),
    inverseSurface: Color(0xFFEAEEF2),
    onInverseSurface: Color(0xFF15212A),
    inversePrimary: Color(0xFF00684D),
  );
}
