import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/theme/app_colors.dart';
import 'package:quran_institution_app/core/theme/app_theme.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/data/sources/profile_data.dart';
import 'package:quran_institution_app/features/home/widgets/home_category_grid.dart';
import 'package:quran_institution_app/features/home/widgets/home_featured_card.dart';
import 'package:quran_institution_app/features/home/widgets/home_header.dart';
import 'package:quran_institution_app/features/home/widgets/home_hero.dart';
import 'package:quran_institution_app/features/home/widgets/home_palette.dart';
import 'package:quran_institution_app/features/home/widgets/home_stats_card.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Tests for the reference-faithful Home redesign. Beyond "it renders", these
/// lock down that Home shows only real figures, keeps the provenance markers,
/// never leaks the reference image's invented content, and confines the green.

const homeSourceFiles = [
  'lib/features/home/home_screen.dart',
  'lib/features/home/widgets/home_palette.dart',
  'lib/features/home/widgets/home_header.dart',
  'lib/features/home/widgets/home_hero.dart',
  'lib/features/home/widgets/home_stats_card.dart',
  'lib/features/home/widgets/home_category_grid.dart',
  'lib/features/home/widgets/home_featured_card.dart',
];

/// Content that belongs to the reference image, not this institution. These are
/// matched as substrings, so every entry must be text this institution never
/// legitimately uses. The reference categories «اللغة العربية» and
/// «العلوم الشرعية» are deliberately omitted: both are real profile content
/// (a target group and a study field), so blocking them would false-fail on
/// genuine data. The three category names kept here appear nowhere in lib/data.
const forbiddenContent = [
  '12,500', '12500', '1,200', '1200', 'حلقة نشطة', 'خريج',
  'علوم القرآن', 'العقيدة والفقه', 'المهارات الحياتية',
];

class _FixedTextScale extends TextScaleNotifier {
  _FixedTextScale(this.value);
  final double value;
  @override
  double build() => value;
}

void main() {
  late ProviderContainer container;

  String location() => container
      .read(routerProvider)
      .routerDelegate
      .currentConfiguration
      .last
      .matchedLocation;

  Future<void> openHome(
    WidgetTester tester, {
    Size size = const Size(390, 900),
    double textScale = 1.0,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    container = ProviderContainer(
      overrides: [textScaleProvider.overrideWith(() => _FixedTextScale(textScale))],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const QuranInstitutionApp(),
      ),
    );
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    container.read(routerProvider).go('/home');
    await tester.pumpAndSettle();
  }

  Future<void> scrollTo(WidgetTester tester, Finder finder) async {
    if (finder.evaluate().isEmpty) {
      await tester.scrollUntilVisible(finder, 300,
          scrollable: find.byType(Scrollable).first);
      await tester.pumpAndSettle();
    }
    await tester.ensureVisible(finder.first);
    await tester.pumpAndSettle();
  }

  Future<void> scrollToBottom(WidgetTester tester) async {
    for (var i = 0; i < 8; i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -320));
      await tester.pumpAndSettle();
    }
  }

  // ── Rendering & overflow ──────────────────────────────────────────────────
  for (final (label, size, scale) in const [
    ('هاتف صغير', Size(360, 690), 1.0),
    ('هاتف صغير · خط أكبر', Size(360, 690), 1.3),
    ('لوحي', Size(768, 1024), 1.0),
  ]) {
    testWidgets('يُرسم بلا تجاوز — $label', (tester) async {
      await openHome(tester, size: size, textScale: scale);
      expect(tester.takeException(), isNull);
      expect(find.byType(HomeHeader), findsOneWidget);
      expect(find.byType(HomeHero), findsOneWidget);
      await scrollToBottom(tester);
      expect(tester.takeException(), isNull);
      expect(find.byType(HomeCategoryGrid), findsOneWidget);
      expect(find.byType(HomeFeaturedCard), findsOneWidget);
    });
  }

  // ── Only real figures ─────────────────────────────────────────────────────
  testWidgets('بطاقة الإحصاءات تعرض أرقاماً حقيقية من الملف التعريفي',
      (tester) async {
    await openHome(tester);
    await scrollTo(tester, find.byType(HomeStatsCard));

    final expected = {
      '${ProfileData.departments.length}': true, // 5
      '${ProfileData.totalHalaqat}': true, // 45
      '${ProfileData.studyFields.length}': true, // 6
      '${ProfileData.companionPrograms.length}': true, // 4
    };
    for (final value in expected.keys) {
      expect(
        find.descendant(
            of: find.byType(HomeStatsCard), matching: find.text(value)),
        findsOneWidget,
        reason: 'الرقم $value غير موجود في بطاقة الإحصاءات',
      );
    }
    expect(ProfileData.totalHalaqat, 45);
  });

  testWidgets('شبكة الأقسام تعرض الأقسام الخمسة الحقيقية', (tester) async {
    await openHome(tester);
    await scrollTo(tester, find.byType(HomeCategoryGrid));
    for (final dep in ProfileData.departments) {
      expect(
        find.descendant(
            of: find.byType(HomeCategoryGrid), matching: find.text(dep.name)),
        findsOneWidget,
      );
    }
  });

  testWidgets('البطاقة المميّزة هي قسم التهجي بمحتوى حقيقي', (tester) async {
    await openHome(tester);
    await scrollTo(tester, find.byType(HomeFeaturedCard));
    expect(
      find.descendant(
          of: find.byType(HomeFeaturedCard), matching: find.text('قسم التهجي')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(HomeFeaturedCard),
        matching: find.textContaining('استيعاب 40 مجموعة'),
      ),
      findsOneWidget,
    );
  });

  // ── No invented content ───────────────────────────────────────────────────
  test('ملفات الشاشة لا تحتوي أي محتوى مخترَع من الصورة المرجعية', () {
    for (final path in homeSourceFiles) {
      final source = File(path).readAsStringSync();
      for (final forbidden in forbiddenContent) {
        expect(source.contains(forbidden), isFalse,
            reason: 'محتوى مخترَع في $path: $forbidden');
      }
    }
  });

  testWidgets('لا يظهر أي محتوى مخترَع عند أي موضع تمرير', (tester) async {
    await openHome(tester);
    void checkTree() {
      for (final forbidden in forbiddenContent) {
        expect(find.textContaining(forbidden), findsNothing,
            reason: 'محتوى مخترَع ظهر على الشاشة: $forbidden');
      }
    }

    checkTree();
    for (var i = 0; i < 10; i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -320));
      await tester.pumpAndSettle();
      checkTree();
    }
  });

  // ── Provenance markers survive ────────────────────────────────────────────
  testWidgets('يحتفظ بعلامات المصدر والبيانات التجريبية', (tester) async {
    await openHome(tester);

    expect(
      find.descendant(
          of: find.byType(HomeHeader), matching: find.byType(SourceChip)),
      findsOneWidget,
    );
    // Exactly one MockChip on Home: the hero greeting.
    expect(
      find.descendant(
          of: find.byType(HomeHero), matching: find.byType(MockChip)),
      findsOneWidget,
    );

    await scrollTo(tester, find.byType(HomeStatsCard));
    expect(
      find.descendant(
          of: find.byType(HomeStatsCard), matching: find.byType(SourceChip)),
      findsWidgets,
    );
    await scrollTo(tester, find.byType(HomeFeaturedCard));
    expect(
      find.descendant(
          of: find.byType(HomeFeaturedCard), matching: find.byType(SourceChip)),
      findsOneWidget,
    );
  });

  // ── Navigation ────────────────────────────────────────────────────────────
  testWidgets('زر الهيرو يفتح الحلقة الحالية', (tester) async {
    await openHome(tester);
    await tester.tap(
      find.descendant(
          of: find.byType(HomeHero),
          matching: find.text('تابعي حلقتك القادمة')),
    );
    await tester.pumpAndSettle();
    expect(location(), startsWith('/programs/'));
    expect(location(), contains('/levels/'));
  });

  testWidgets('بطاقة القسم تفتح تفاصيله', (tester) async {
    await openHome(tester);
    await scrollTo(tester, find.text('قسم تجويد متقدم'));
    await tester.tap(find.text('قسم تجويد متقدم'));
    await tester.pumpAndSettle();
    expect(location(), '/programs/dep-tajweed-3');
  });

  testWidgets('البطاقة المميّزة تفتح قسم التهجي', (tester) async {
    await openHome(tester);
    await scrollTo(tester, find.byType(HomeFeaturedCard));
    await tester.tap(find.byType(HomeFeaturedCard));
    await tester.pumpAndSettle();
    expect(location(), '/programs/sec-spelling');
  });

  testWidgets('إجراء «عرض جميع الأقسام» يفتح البرامج', (tester) async {
    await openHome(tester);
    await scrollTo(tester, find.text('عرض جميع الأقسام'));
    await tester.tap(find.text('عرض جميع الأقسام'));
    await tester.pumpAndSettle();
    expect(location(), '/programs');
  });

  // ── Async gating: never a fabricated zero ─────────────────────────────────
  testWidgets('لا يعرض صفراً بينما تتحمّل البيانات', (tester) async {
    tester.view.physicalSize = const Size(390, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    container = ProviderContainer();
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
          container: container, child: const QuranInstitutionApp()),
    );
    await tester.pump(const Duration(seconds: 3));
    container.read(routerProvider).go('/home');
    await tester.pump(); // one frame — providers still resolving
    expect(find.text('0'), findsNothing);
    expect(find.byType(HomeStatsCard), findsNothing);
    await tester.pumpAndSettle();
    expect(find.byType(HomeStatsCard), findsOneWidget);
  });

  // ── Tap targets ───────────────────────────────────────────────────────────
  for (final scale in const [1.0, 1.3]) {
    testWidgets('أهداف اللمس لا تقل عن 48dp — مقياس خط $scale', (tester) async {
      await openHome(tester, size: const Size(360, 690), textScale: scale);
      final measured = <String, Size>{};
      void measure() {
        for (final type in const [FilledButton, TextButton, IconButton]) {
          final b = find.byType(type);
          for (var i = 0; i < b.evaluate().length; i++) {
            final size = tester.getSize(b.at(i));
            measured['$type#${size.width.toInt()}x${size.height.toInt()}'] =
                size;
          }
        }
      }

      measure();
      for (var i = 0; i < 10; i++) {
        await tester.drag(find.byType(Scrollable).first, const Offset(0, -320));
        await tester.pumpAndSettle();
        measure();
      }
      expect(measured, isNotEmpty);
      // Height is the guarantee for every target; for icon buttons the visual
      // box IS the tap target, so width must clear 48 too (text/filled buttons
      // stretch to their label and rely on a padded tap target instead).
      measured.forEach((k, size) {
        expect(size.height, greaterThanOrEqualTo(48.0),
            reason: '$k ارتفاعه أصغر من 48dp');
        if (k.startsWith('IconButton')) {
          expect(size.width, greaterThanOrEqualTo(48.0),
              reason: '$k عرضه أصغر من 48dp');
        }
      });
    });
  }

  // ── Green scoped, no leak ─────────────────────────────────────────────────
  testWidgets('الأخضر محصور في الرئيسية ولا يتسرّب إلى الهيكل المشترك',
      (tester) async {
    await openHome(tester);
    expect(
      Theme.of(tester.element(find.byType(HomeStatsCard))).colorScheme.primary,
      AppColors.accentGreen,
    );
    expect(
      Theme.of(tester.element(find.byType(NavigationBar))).colorScheme.primary,
      AppColors.primary,
    );
  });

  test('لوحة الرئيسية تشتق الأخضر من الشعار', () {
    expect(HomePalette.schemeOf(AppTheme.light.colorScheme).primary,
        AppColors.accentGreen);
    expect(HomePalette.schemeOf(AppTheme.dark.colorScheme).primary,
        AppColors.successDark);
  });

  test('كل تباينات لوحة الرئيسية تجتاز AA في الوضعين', () {
    for (final base in [AppTheme.light.colorScheme, AppTheme.dark.colorScheme]) {
      final s = HomePalette.schemeOf(base);
      final where = 'ثيم ${base.brightness}';
      for (final (name, fg, bg) in [
        ('onPrimary/primary', s.onPrimary, s.primary),
        ('onSurface/surface', s.onSurface, s.surface),
        ('onSurfaceVariant/surface', s.onSurfaceVariant, s.surface),
        ('onPrimaryContainer/primaryContainer', s.onPrimaryContainer,
            s.primaryContainer),
      ]) {
        expect(_contrast(fg, bg), greaterThanOrEqualTo(4.5),
            reason: '$name في $where');
      }
      for (final tone in HomeTileTone.values) {
        final t = HomePalette.tileFor(base.brightness, tone);
        expect(_contrast(t.foreground, t.background),
            greaterThanOrEqualTo(4.5),
            reason: 'بطاقة $tone في $where');
      }
    }
  });

  // ── RTL source lint ───────────────────────────────────────────────────────
  test('ملفات الرئيسية لا تستخدم يمين/يسار ثابتة', () {
    const forbidden = [
      'EdgeInsets.only(left:', 'EdgeInsets.only(right:',
      'Alignment.centerLeft', 'Alignment.centerRight',
      'Alignment.topLeft', 'Alignment.topRight',
      'Alignment.bottomLeft', 'Alignment.bottomRight',
      'Positioned(left:', 'Positioned(right:', 'chevron_left',
    ];
    for (final path in homeSourceFiles) {
      final source = File(path).readAsStringSync();
      for (final token in forbidden) {
        expect(source.contains(token), isFalse,
            reason: '$path يحتوي على "$token" وهو يكسر RTL');
      }
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
  final la = _luminance(a), lb = _luminance(b);
  final hi = la > lb ? la : lb, lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
