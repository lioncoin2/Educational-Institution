import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'app_colors.dart';
import 'app_tokens.dart';
import 'app_typography.dart';

/// Material 3 themes built entirely from [AppColors].
///
/// The profile itself contains both light pink spreads and near-black spreads,
/// so a dark theme is not an invention — it is the other half of the same
/// identity.
abstract final class AppTheme {
  static ThemeData get light {
    const scheme = ColorScheme(
      brightness: Brightness.light,
      primary: AppColors.primary,
      onPrimary: AppColors.white,
      primaryContainer: AppColors.surfaceTint,
      onPrimaryContainer: AppColors.primaryDark,
      secondary: AppColors.primaryLight,
      onSecondary: AppColors.white,
      secondaryContainer: AppColors.surfaceTintSoft,
      onSecondaryContainer: AppColors.primaryDeep,
      tertiary: AppColors.accentGreen,
      onTertiary: AppColors.white,
      tertiaryContainer: Color(0xFFD6EFE6),
      onTertiaryContainer: Color(0xFF00382A),
      error: AppColors.danger,
      onError: AppColors.white,
      errorContainer: Color(0xFFFBDDE0),
      onErrorContainer: Color(0xFF5C1119),
      surface: Color(0xFFFDF8FB),
      onSurface: AppColors.textPrimary,
      surfaceContainerLowest: AppColors.white,
      surfaceContainerLow: Color(0xFFFBF2F7),
      surfaceContainer: Color(0xFFF7E9F1),
      surfaceContainerHigh: AppColors.surfaceTint,
      surfaceContainerHighest: Color(0xFFDFBBD2),
      onSurfaceVariant: AppColors.textSecondary,
      outline: Color(0xFFC9AEBD),
      outlineVariant: Color(0xFFEBD9E4),
      shadow: AppColors.primaryDeep,
      scrim: Color(0x99321624),
      inverseSurface: AppColors.surfaceDark,
      onInverseSurface: AppColors.textOnDark,
      inversePrimary: AppColors.primaryOnDark,
    );
    return _build(scheme);
  }

  static ThemeData get dark {
    const scheme = ColorScheme(
      brightness: Brightness.dark,
      primary: AppColors.primaryOnDark,
      onPrimary: Color(0xFF3D1329),
      primaryContainer: Color(0xFF5D2A45),
      onPrimaryContainer: Color(0xFFFCE0EE),
      secondary: AppColors.primaryLight,
      onSecondary: Color(0xFF3D1329),
      secondaryContainer: Color(0xFF4A2139),
      onSecondaryContainer: Color(0xFFF9D6E7),
      tertiary: AppColors.successDark,
      onTertiary: Color(0xFF00281D),
      tertiaryContainer: Color(0xFF1C4A3B),
      onTertiaryContainer: Color(0xFFCDEDE1),
      error: AppColors.dangerDark,
      onError: Color(0xFF450911),
      errorContainer: Color(0xFF6B1822),
      onErrorContainer: Color(0xFFFCDCE0),
      surface: AppColors.bgDark,
      onSurface: AppColors.textOnDark,
      surfaceContainerLowest: Color(0xFF130A10),
      surfaceContainerLow: Color(0xFF21121B),
      surfaceContainer: AppColors.surfaceDark,
      surfaceContainerHigh: AppColors.surfaceDarkElevated,
      surfaceContainerHighest: Color(0xFF48283A),
      onSurfaceVariant: Color(0xFFD5BCC9),
      outline: Color(0xFF7A5A6B),
      outlineVariant: Color(0xFF4A3140),
      shadow: Color(0xFF000000),
      scrim: Color(0xCC0B0509),
      inverseSurface: AppColors.surfaceTint,
      onInverseSurface: AppColors.primaryDark,
      inversePrimary: AppColors.primary,
    );
    return _build(scheme);
  }

  static ThemeData _build(ColorScheme scheme) {
    final text =
        AppTypography.textTheme(scheme.onSurface, scheme.onSurfaceVariant);

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      textTheme: text,
      fontFamily: AppFonts.body,
      splashFactory: InkSparkle.splashFactory,
      visualDensity: VisualDensity.standard,
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: text.titleLarge,
        iconTheme: IconThemeData(color: scheme.onSurface),
      ),
      cardTheme: CardThemeData(
        color: scheme.surfaceContainerLowest,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: const RoundedRectangleBorder(borderRadius: Radii.brLg),
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        thickness: 1,
        space: 1,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: Insets.xxl),
          shape: const RoundedRectangleBorder(borderRadius: Radii.pill),
          textStyle: text.labelLarge,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: Insets.xxl),
          shape: const RoundedRectangleBorder(borderRadius: Radii.pill),
          side: BorderSide(color: scheme.outline),
          textStyle: text.labelLarge,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 44),
          shape: const RoundedRectangleBorder(borderRadius: Radii.brMd),
          textStyle: text.labelLarge,
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surfaceContainerLowest,
        indicatorColor: scheme.primaryContainer,
        elevation: 0,
        height: 68,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? text.labelSmall!.copyWith(
                  fontWeight: FontWeight.w600,
                  color: scheme.onPrimaryContainer,
                )
              : text.labelSmall!,
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            size: 24,
            color: states.contains(WidgetState.selected)
                ? scheme.onPrimaryContainer
                : scheme.onSurfaceVariant,
          ),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: scheme.surfaceContainerLowest,
        indicatorColor: scheme.primaryContainer,
        selectedLabelTextStyle:
            text.labelMedium!.copyWith(color: scheme.onPrimaryContainer),
        unselectedLabelTextStyle: text.labelMedium,
        selectedIconTheme: IconThemeData(color: scheme.onPrimaryContainer),
        unselectedIconTheme: IconThemeData(color: scheme.onSurfaceVariant),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: scheme.surfaceContainer,
        side: BorderSide.none,
        labelStyle: text.labelMedium!,
        shape: const RoundedRectangleBorder(borderRadius: Radii.pill),
        padding: const EdgeInsets.symmetric(
          horizontal: Insets.md,
          vertical: Insets.sm,
        ),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHighest,
        circularTrackColor: scheme.surfaceContainerHighest,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: scheme.inverseSurface,
        contentTextStyle:
            text.bodyMedium!.copyWith(color: scheme.onInverseSurface),
        shape: const RoundedRectangleBorder(borderRadius: Radii.brMd),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surfaceContainerLow,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radii.xl),
        ),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
          TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
          TargetPlatform.windows: FadeForwardsPageTransitionsBuilder(),
          TargetPlatform.linux: FadeForwardsPageTransitionsBuilder(),
        },
      ),
    );
  }
}
