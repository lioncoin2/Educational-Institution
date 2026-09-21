import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/theme/app_colors.dart';
import 'package:quran_institution_app/core/theme/app_theme.dart';
import 'package:quran_institution_app/data/sources/mock_data.dart';
import 'package:quran_institution_app/data/sources/profile_data.dart';

void main() {
  testWidgets('app boots into the splash screen in RTL', (tester) async {
    await tester.pumpWidget(
      const ProviderScope(child: QuranInstitutionApp()),
    );
    await tester.pump();

    expect(find.text(ProfileData.institution.name), findsOneWidget);

    final directionality = tester.widget<Directionality>(
      find.byType(Directionality).first,
    );
    expect(directionality.textDirection, TextDirection.rtl);

    // Let the splash timer fire and the home screen's repositories resolve,
    // so no timers are left pending when the test ends.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    // Home boots into the institutional hero welcome.
    expect(find.textContaining('مرحباً بك'), findsWidgets);
  });

  test('the five departments and their halaqat match the profile', () {
    expect(ProfileData.departments.length, 5);
    expect(ProfileData.totalHalaqat, 45);
    expect(
      ProfileData.departments.map((d) => d.halaqatCount).toList(),
      [5, 10, 10, 10, 10],
    );
  });

  test('mock halaqat are generated to the counts stated in the profile', () {
    for (final department in ProfileData.departments) {
      expect(
        MockData.halaqatFor(department).length,
        department.halaqatCount,
        reason: 'عدد حلقات ${department.name} يجب أن يطابق الملف التعريفي',
      );
    }
  });

  test('gold is never used as text on a light surface', () {
    // 2.54:1 against white — decorative on dark surfaces only.
    expect(_contrast(AppColors.accentGold, AppColors.white) < 4.5, isTrue);
    expect(_contrast(AppColors.accentGold, AppColors.bgDark) >= 4.5, isTrue);
  });

  test('primary plum passes AA against white', () {
    expect(_contrast(AppColors.primary, AppColors.white) >= 4.5, isTrue);
    expect(_contrast(AppColors.primaryDeep, AppColors.white) >= 7, isTrue);
  });

  test('brand bands stay readable in both themes', () {
    // The plum header bands paint onPrimary over primary. In the dark theme
    // primary is a light pink, so hardcoding white text there would fail.
    for (final theme in [AppTheme.light, AppTheme.dark]) {
      final scheme = theme.colorScheme;
      expect(
        _contrast(scheme.onPrimary, scheme.primary) >= 4.5,
        isTrue,
        reason: 'onPrimary/primary في ثيم ${scheme.brightness}',
      );
      expect(
        _contrast(scheme.onSurface, scheme.surface) >= 4.5,
        isTrue,
        reason: 'onSurface/surface في ثيم ${scheme.brightness}',
      );
      expect(
        _contrast(scheme.onSurfaceVariant, scheme.surface) >= 4.5,
        isTrue,
        reason: 'onSurfaceVariant/surface في ثيم ${scheme.brightness}',
      );
      expect(
        _contrast(scheme.onPrimaryContainer, scheme.primaryContainer) >= 4.5,
        isTrue,
        reason: 'onPrimaryContainer في ثيم ${scheme.brightness}',
      );
    }
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
  final la = _luminance(a);
  final lb = _luminance(b);
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
