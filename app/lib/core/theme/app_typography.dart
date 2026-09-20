import 'package:flutter/material.dart';

/// Type scale.
///
/// The profile PDF uses `29LT Adir` and `RTL MediaPro` (commercial) plus
/// `Almarai`. We ship the open-licensed pair that matches their roles:
/// Almarai for the heavy geometric headings, IBM Plex Sans Arabic for body
/// copy. Fonts are bundled, never fetched at runtime — a network font would
/// flash tofu on Flutter Web before it loads.
abstract final class AppFonts {
  static const String display = 'Almarai';
  static const String body = 'PlexArabic';

  /// Reserved for Quranic text only. Never use it for UI copy.
  static const String quran = 'AmiriQuran';
}

abstract final class AppTypography {
  /// Arabic needs more vertical room than Latin: diacritics and dots sit
  /// outside the x-height band.
  static const double _headingHeight = 1.35;
  static const double _bodyHeight = 1.6;

  static TextTheme textTheme(Color onSurface, Color onSurfaceVariant) {
    return TextTheme(
      displayLarge: TextStyle(
        fontFamily: AppFonts.display,
        fontSize: 40,
        fontWeight: FontWeight.w800,
        height: _headingHeight,
        color: onSurface,
      ),
      headlineLarge: TextStyle(
        fontFamily: AppFonts.display,
        fontSize: 32,
        fontWeight: FontWeight.w700,
        height: _headingHeight,
        color: onSurface,
      ),
      headlineMedium: TextStyle(
        fontFamily: AppFonts.display,
        fontSize: 26,
        fontWeight: FontWeight.w700,
        height: _headingHeight,
        color: onSurface,
      ),
      titleLarge: TextStyle(
        fontFamily: AppFonts.display,
        fontSize: 20,
        fontWeight: FontWeight.w700,
        height: _headingHeight,
        color: onSurface,
      ),
      titleMedium: TextStyle(
        fontFamily: AppFonts.body,
        fontSize: 17,
        fontWeight: FontWeight.w600,
        height: 1.45,
        color: onSurface,
      ),
      titleSmall: TextStyle(
        fontFamily: AppFonts.body,
        fontSize: 15,
        fontWeight: FontWeight.w600,
        height: 1.45,
        color: onSurface,
      ),
      bodyLarge: TextStyle(
        fontFamily: AppFonts.body,
        fontSize: 16,
        fontWeight: FontWeight.w400,
        height: _bodyHeight,
        color: onSurface,
      ),
      bodyMedium: TextStyle(
        fontFamily: AppFonts.body,
        fontSize: 14.5,
        fontWeight: FontWeight.w400,
        height: _bodyHeight,
        color: onSurfaceVariant,
      ),
      bodySmall: TextStyle(
        fontFamily: AppFonts.body,
        fontSize: 13,
        fontWeight: FontWeight.w400,
        height: 1.5,
        color: onSurfaceVariant,
      ),
      labelLarge: TextStyle(
        fontFamily: AppFonts.body,
        fontSize: 15,
        fontWeight: FontWeight.w600,
        height: 1.3,
        color: onSurface,
      ),
      labelMedium: TextStyle(
        fontFamily: AppFonts.body,
        fontSize: 13,
        fontWeight: FontWeight.w500,
        height: 1.3,
        color: onSurfaceVariant,
      ),
      labelSmall: TextStyle(
        fontFamily: AppFonts.body,
        fontSize: 11.5,
        fontWeight: FontWeight.w500,
        height: 1.3,
        color: onSurfaceVariant,
      ),
    );
  }
}
