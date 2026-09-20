import 'package:flutter/material.dart';

/// Colour palette of the institution.
///
/// Every value below was sampled directly from the pixels of
/// `docs/institution-profile.pdf` (see `docs/pdf-content-extract.md`).
/// Nothing here is invented.
abstract final class AppColors {
  // ── Primary family (page backgrounds & headings in the profile) ──────────
  /// Dominant background of pages 3, 6, 8, 9, 13.
  static const Color primary = Color(0xFF8A4269);

  /// Deep plum used for emphasised text on pages 6 and 14.
  static const Color primaryDeep = Color(0xFF721D49);

  /// Heading colour on the light pages (2, 4, 10, 14).
  static const Color primaryDark = Color(0xFF66334A);

  /// Mid pink used for borders and accents.
  static const Color primaryLight = Color(0xFFC1679C);

  /// Soft pink, secondary elements on page 9.
  static const Color primarySoft = Color(0xFFD597BC);

  // ── Light surfaces ───────────────────────────────────────────────────────
  /// Background of the light pages (2, 4, 10, 14).
  static const Color surfaceTint = Color(0xFFE7CCDD);

  /// Card edge glow on page 6.
  static const Color surfaceTintSoft = Color(0xFFFFE2F2);

  /// Card surface on page 4.
  static const Color surfaceAlt = Color(0xFFF2F6FF);

  static const Color white = Color(0xFFFFFFFF);

  // ── Logo accents ─────────────────────────────────────────────────────────
  /// Green from the open book in the emblem. Success states only.
  static const Color accentGreen = Color(0xFF006B4F);

  /// Gold from the emblem ring. DECORATIVE ONLY — contrast on white is
  /// 2.54:1, which fails WCAG for text. Safe on dark surfaces (7.40:1).
  static const Color accentGold = Color(0xFFBF9F4C);

  // ── Dark theme (mirrors the near-black pages 1, 5, 7, 11, 12) ────────────
  static const Color bgDark = Color(0xFF1A0E16);
  static const Color surfaceDark = Color(0xFF2A1622);
  static const Color surfaceDarkElevated = Color(0xFF3A2030);
  static const Color primaryOnDark = Color(0xFFD597BC);
  static const Color textOnDark = Color(0xFFF6EAF1);

  // ── Semantic ─────────────────────────────────────────────────────────────
  static const Color success = Color(0xFF006B4F);
  static const Color successDark = Color(0xFF3FA27F);
  static const Color warning = Color(0xFFB26A00);
  static const Color warningDark = Color(0xFFE09B3D);
  static const Color danger = Color(0xFFA32A38);
  static const Color dangerDark = Color(0xFFE4707C);
  static const Color info = Color(0xFF2E5C8A);
  static const Color infoDark = Color(0xFF7BAEE0);

  // ── Text ─────────────────────────────────────────────────────────────────
  static const Color textPrimary = Color(0xFF2E1622);
  static const Color textSecondary = Color(0xFF6B5260);
  static const Color textOnPrimary = Color(0xFFFFFFFF);

  /// Amber used exclusively by the "mock data" ribbon so that it can never be
  /// confused with the institution's own identity colours.
  static const Color mockAmber = Color(0xFF8A6100);
  static const Color mockAmberBg = Color(0xFFFFF4D6);
  static const Color mockAmberBgDark = Color(0xFF3A2E12);
}
