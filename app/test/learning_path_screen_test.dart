import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/theme/app_colors.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/core/widgets/patterns/path_stepper.dart';
import 'package:quran_institution_app/data/sources/profile_data.dart';
import 'package:quran_institution_app/features/learning_path/widgets/path_continue_card.dart';
import 'package:quran_institution_app/features/learning_path/widgets/path_hero_band.dart';
import 'package:quran_institution_app/features/learning_path/widgets/path_overview_card.dart';
import 'package:quran_institution_app/features/learning_path/widgets/path_palette.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Tests for the redesigned مساري screen.
///
/// Three things are locked down here beyond "it renders": that the screen shows
/// only figures the codebase can actually supply, that the provenance markers
/// survive the restyle, and that the institutional green stays scoped to this
/// one screen.

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

  Future<void> openPath(
    WidgetTester tester, {
    Size size = const Size(390, 900),
    double textScale = 1.0,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    container = ProviderContainer(
      overrides: [
        textScaleProvider.overrideWith(() => _FixedTextScale(textScale)),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const QuranInstitutionApp(),
      ),
    );
    await tester.pump(const Duration(seconds: 3)); // clear the splash timer
    await tester.pumpAndSettle();
    container.read(routerProvider).go('/path');
    await tester.pumpAndSettle();
  }

  /// Slivers below the fold are not built until scrolled into range.
  Future<void> scrollTo(WidgetTester tester, Finder finder) async {
    if (finder.evaluate().isEmpty) {
      await tester.scrollUntilVisible(
        finder,
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
    }
    await tester.ensureVisible(finder.first);
    await tester.pumpAndSettle();
  }

  Future<void> scrollToBottom(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -700));
      await tester.pumpAndSettle();
    }
  }

  // ── Rendering and overflow ────────────────────────────────────────────────

  for (final (label, size, scale) in const [
    ('هاتف صغير', Size(360, 690), 1.0),
    ('هاتف صغير · خط أكبر', Size(360, 690), 1.3),
    ('لوحي', Size(768, 1024), 1.0),
  ]) {
    testWidgets('يُرسم بلا تجاوز — $label', (tester) async {
      await openPath(tester, size: size, textScale: scale);

      expect(tester.takeException(), isNull);
      expect(find.byType(PathHeroBand), findsOneWidget);
      expect(find.byType(PathOverviewCard), findsOneWidget);

      await scrollToBottom(tester);
      expect(tester.takeException(), isNull);
      expect(find.byType(PathStepper), findsOneWidget);
    });
  }

  // ── Content: only what the codebase can supply ────────────────────────────

  testWidgets('يعرض العناوين والأرقام الحقيقية من الملف التعريفي',
      (tester) async {
    await openPath(tester);

    // The string test/layout_test.dart asserts for /path, kept verbatim.
    expect(find.textContaining('المنهج المتدرّج'), findsWidgets);
    expect(find.text('مساري'), findsWidgets); // hero heading + nav label

    // Real page-6 figures, scoped: a bare find.text('5') would also match the
    // stepper's marker for the fifth department.
    expect(
      find.descendant(
        of: find.byType(PathOverviewCard),
        matching: find.text('${ProfileData.departments.length}'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(PathOverviewCard),
        matching: find.text('${ProfileData.totalHalaqat}'),
      ),
      findsOneWidget,
    );
    expect(ProfileData.totalHalaqat, 45);
  });

  testWidgets('أرقام التقدّم التجريبية مشتقّة من المزوّد لا مكتوبة يدوياً',
      (tester) async {
    await openPath(tester);
    final progress = await container.read(progressProvider.future);

    expect(
      find.descendant(
        of: find.byType(PathOverviewCard),
        matching: find.text('${progress.completedHalaqat}'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(PathOverviewCard),
        matching: find.text('${(progress.attendanceRatio * 100).round()}%'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('لا يحتوي أي محتوى مخترَع من الصورة المرجعية', (tester) async {
    await openPath(tester);
    await scrollToBottom(tester);

    // Figures and categories that belong to the reference image, not to this
    // institution. None of them may ever appear on this screen.
    for (final forbidden in const [
      '12,500',
      '12500',
      '1,200',
      '1200',
      'حلقة نشطة',
      'خريج',
      'علوم القرآن',
      'العقيدة والفقه',
      'اللغة العربية',
      'العلوم الشرعية',
      'المهارات الحياتية',
    ]) {
      expect(
        find.textContaining(forbidden),
        findsNothing,
        reason: 'محتوى مخترَع ظهر على الشاشة: $forbidden',
      );
    }
  });

  // ── Provenance markers survive the restyle ────────────────────────────────

  testWidgets('يحتفظ بعلامات المصدر والبيانات التجريبية', (tester) async {
    await openPath(tester);

    expect(find.byType(SourceChip), findsWidgets);
    expect(find.byType(MockChip), findsWidgets);

    await scrollTo(tester, find.byType(MockBanner));
    expect(find.byType(MockBanner), findsOneWidget);
    expect(
      find.textContaining('ترتيب الأقسام وعدد حلقاتها مأخوذان من الملف التعريفي'),
      findsOneWidget,
    );
  });

  // ── Navigation ────────────────────────────────────────────────────────────

  testWidgets('زر المتابعة في الترويسة يفتح مستويات القسم الحالي',
      (tester) async {
    await openPath(tester);
    await tester.tap(
      find.descendant(
        of: find.byType(PathHeroBand),
        matching: find.text('تابعي مسارك'),
      ),
    );
    await tester.pumpAndSettle();
    expect(location(), '/programs/dep-tajweed-2/levels');
  });

  testWidgets('بطاقة القسم الحالي تفتح الحلقة', (tester) async {
    await openPath(tester);
    await scrollTo(tester, find.byType(PathContinueCard));
    await tester.tap(
      find.descendant(
        of: find.byType(PathContinueCard),
        matching: find.text('ادخلي الحلقة'),
      ),
    );
    await tester.pumpAndSettle();
    expect(location(), startsWith('/programs/dep-tajweed-2/levels/'));
  });

  testWidgets('السلّم ما زال يفتح مستويات القسم', (tester) async {
    await openPath(tester);
    await scrollTo(tester, find.text('قسم تجويد مبتدئ'));
    await tester.tap(find.text('قسم تجويد مبتدئ').first);
    await tester.pumpAndSettle();
    expect(location(), '/programs/dep-tajweed-1/levels');
  });

  testWidgets('إجراء العنوان يفتح شاشة التقدّم ويُبقي مساري محدّداً',
      (tester) async {
    await openPath(tester);
    await scrollTo(tester, find.text('تفاصيل تقدّمي'));
    await tester.tap(find.text('تفاصيل تقدّمي'));
    await tester.pumpAndSettle();
    expect(location(), '/progress');

    // A root push, so popping returns to /path with the tab still selected.
    container.read(routerProvider).pop();
    await tester.pumpAndSettle();
    expect(location(), '/path');
  });

  // ── Accessibility ─────────────────────────────────────────────────────────

  for (final scale in const [1.0, 1.3]) {
    testWidgets('أهداف اللمس لا تقل عن 48dp — مقياس خط $scale',
        (tester) async {
      await openPath(tester, size: const Size(360, 690), textScale: scale);
      await scrollToBottom(tester);

      for (final type in const [FilledButton, TextButton]) {
        final buttons = find.byType(type);
        for (var i = 0; i < buttons.evaluate().length; i++) {
          expect(
            tester.getSize(buttons.at(i)).height,
            greaterThanOrEqualTo(48.0),
            reason: '$type رقم $i أصغر من 48dp',
          );
        }
      }
    });
  }

  testWidgets('الاتجاه من اليمين إلى اليسار', (tester) async {
    await openPath(tester);
    expect(
      Directionality.of(tester.element(find.byType(PathOverviewCard))),
      TextDirection.rtl,
    );
  });

  // ── The green stays scoped to this screen ─────────────────────────────────

  testWidgets('الأخضر محصور في شاشة مساري ولا يتسرّب إلى الهيكل المشترك',
      (tester) async {
    await openPath(tester);

    // Inside the screen: the institution's emblem green.
    expect(
      Theme.of(tester.element(find.byType(PathOverviewCard)))
          .colorScheme
          .primary,
      AppColors.accentGreen,
    );

    // The shared navigation shell sits above the scoped Theme and must keep
    // the app's plum — this is what proves no other tab is affected.
    expect(
      Theme.of(tester.element(find.byType(NavigationBar))).colorScheme.primary,
      AppColors.primary,
    );
  });

  test('لوحة الألوان المحصورة تشتق الأخضر من شعار المؤسسة', () {
    final light = PathPalette.schemeOf(
      const ColorScheme.light().copyWith(brightness: Brightness.light),
    );
    expect(light.primary, AppColors.accentGreen);

    final dark = PathPalette.schemeOf(
      const ColorScheme.dark().copyWith(brightness: Brightness.dark),
    );
    expect(dark.primary, AppColors.successDark);
  });

  // ── RTL source lint ───────────────────────────────────────────────────────

  test('ملفات الشاشة الجديدة لا تستخدم يمين/يسار ثابتة', () {
    const files = [
      'lib/features/learning_path/learning_path_screen.dart',
      'lib/features/learning_path/widgets/path_palette.dart',
      'lib/features/learning_path/widgets/path_hero_band.dart',
      'lib/features/learning_path/widgets/path_stat_tile.dart',
      'lib/features/learning_path/widgets/path_overview_card.dart',
      'lib/features/learning_path/widgets/path_continue_card.dart',
    ];
    const forbidden = [
      'EdgeInsets.only(left:',
      'EdgeInsets.only(right:',
      'Alignment.centerLeft',
      'Alignment.centerRight',
      'Alignment.topLeft',
      'Alignment.topRight',
      'Alignment.bottomLeft',
      'Alignment.bottomRight',
      'Positioned(left:',
      'Positioned(right:',
      'chevron_left',
    ];
    for (final path in files) {
      final source = File(path).readAsStringSync();
      for (final token in forbidden) {
        expect(
          source.contains(token),
          isFalse,
          reason: '$path يحتوي على "$token" وهو يكسر RTL',
        );
      }
    }
  });
}
