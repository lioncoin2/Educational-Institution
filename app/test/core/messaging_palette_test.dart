import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/core/theme/app_colors.dart';
import 'package:quran_institution_app/core/theme/app_theme.dart';
import 'package:quran_institution_app/core/theme/messaging_palette.dart';

/// The messaging surface's refined green/cream palette (owner design reference).
/// These assertions pin the exact tokens, keep it DISTINCT from the plum global
/// theme, and prove every text pairing meets WCAG AA in both brightnesses, so a
/// drift fails here rather than on a device. The rendered result is captured
/// separately as golden images in `test/messaging/golden/`.
void main() {
  // Bubbles read these at paint (message_bubble.dart): sent = primaryContainer,
  // received = surfaceContainerHigh, message text = onSurface (bodyMedium).

  test('exact reference tokens (light)', () {
    final s = MessagingPalette.schemeOf(AppTheme.light.colorScheme);
    expect(s.primary, const Color(0xFF0F7A5A)); // أخضر أساسي
    expect(s.secondary, const Color(0xFF16A085)); // أخضر متوسط
    expect(s.secondaryContainer, const Color(0xFFE6F4EE)); // أخضر فاتح
    expect(s.surface, const Color(0xFFF7FBFA)); // خلفية عامة
    expect(s.surfaceContainerLow, const Color(0xFFF9F5E9)); // كريمي (بطاقات)
    expect(s.primaryContainer, const Color(0xFFD1E9E2)); // فقاعة مرسلة
    expect(s.surfaceContainerHigh, const Color(0xFFE6F0ED)); // فقاعة مستلمة
    // Never the plum global primary.
    expect(s.primary, isNot(AppColors.primary)); // not #8A4269
  });

  test('sent and received bubbles are distinct in both modes', () {
    for (final base in [
      AppTheme.light.colorScheme,
      AppTheme.dark.colorScheme,
    ]) {
      final s = MessagingPalette.schemeOf(base);
      expect(s.primaryContainer, isNot(s.surfaceContainerHigh),
          reason: 'sent vs received identical (${base.brightness})');
      // The owner's two light tints are close by design; shape, tail and
      // alignment carry the rest. Still a measurable separation.
      expect(_contrast(s.primaryContainer, s.surfaceContainerHigh),
          greaterThan(1.05),
          reason: 'sent vs received too close (${base.brightness})');
    }
  });

  test('message text is readable on both bubble fills (AA) in both modes', () {
    for (final base in [
      AppTheme.light.colorScheme,
      AppTheme.dark.colorScheme,
    ]) {
      final s = MessagingPalette.schemeOf(base);
      final where = 'theme ${base.brightness}';
      expect(_contrast(s.onSurface, s.primaryContainer),
          greaterThanOrEqualTo(4.5),
          reason: 'sent-bubble text in $where');
      expect(_contrast(s.onSurface, s.surfaceContainerHigh),
          greaterThanOrEqualTo(4.5),
          reason: 'received-bubble text in $where');
    }
  });

  test('every text pairing passes AA in both modes', () {
    for (final base in [
      AppTheme.light.colorScheme,
      AppTheme.dark.colorScheme,
    ]) {
      final s = MessagingPalette.schemeOf(base);
      final where = 'theme ${base.brightness}';
      for (final (name, fg, bg) in [
        ('onPrimary/primary', s.onPrimary, s.primary),
        ('onSurface/surface', s.onSurface, s.surface),
        ('onSurfaceVariant/surface', s.onSurfaceVariant, s.surface),
        ('onPrimaryContainer/primaryContainer', s.onPrimaryContainer,
            s.primaryContainer),
        ('onSecondaryContainer/secondaryContainer', s.onSecondaryContainer,
            s.secondaryContainer),
      ]) {
        expect(_contrast(fg, bg), greaterThanOrEqualTo(4.5), reason: '$name in $where');
      }
      // secondary (#16A085) is an accent fill for non-text / large elements:
      // the 3:1 floor, not 4.5. (It is never used for body text.)
      expect(_contrast(s.onSecondary, s.secondary), greaterThanOrEqualTo(3.0),
          reason: 'onSecondary/secondary in $where');
    }
  });

  testWidgets('themeOf wraps the ambient theme in green, not plum', (tester) async {
    late ThemeData scoped;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Builder(
          builder: (context) {
            scoped = MessagingPalette.themeOf(context);
            return const SizedBox.shrink();
          },
        ),
      ),
    );
    expect(scoped.colorScheme.primary, const Color(0xFF0F7A5A));
    expect(scoped.colorScheme.primary, isNot(AppColors.primary));
    expect(scoped.scaffoldBackgroundColor, scoped.colorScheme.surface);
  });
}

double _luminance(Color color) {
  double channel(double v) =>
      v <= 0.04045 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(color.r) +
      0.7152 * channel(color.g) +
      0.0722 * channel(color.b);
}

double _contrast(Color a, Color b) {
  final la = _luminance(a), lb = _luminance(b);
  final hi = la > lb ? la : lb, lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
