import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/theme/app_colors.dart';
import 'package:quran_institution_app/core/theme/app_theme.dart';
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

/// Every source file the redesign owns.
const screenSourceFiles = [
  'lib/features/learning_path/learning_path_screen.dart',
  'lib/features/learning_path/widgets/path_palette.dart',
  'lib/features/learning_path/widgets/path_hero_band.dart',
  'lib/features/learning_path/widgets/path_stat_tile.dart',
  'lib/features/learning_path/widgets/path_overview_card.dart',
  'lib/features/learning_path/widgets/path_continue_card.dart',
];

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
    final progress = (await container.read(progressProvider.future))!;

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

  /// Content that belongs to the reference image, not to this institution.
  const forbiddenContent = [
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
  ];

  // The primary guard is over the SOURCE, not the render tree. A widget-tree
  // sweep can only see what is currently built, and a lazy CustomScrollView
  // disposes slivers as they leave the viewport — so a single check at one
  // scroll offset silently inspects almost nothing. Reading the files also
  // catches strings sitting behind a branch the test never renders.
  test('ملفات الشاشة لا تحتوي أي محتوى مخترَع من الصورة المرجعية', () {
    for (final path in screenSourceFiles) {
      final source = File(path).readAsStringSync();
      for (final forbidden in forbiddenContent) {
        expect(
          source.contains(forbidden),
          isFalse,
          reason: 'محتوى مخترَع في $path: $forbidden',
        );
      }
    }
  });

  testWidgets('لا يظهر أي محتوى مخترَع عند أي موضع تمرير', (tester) async {
    await openPath(tester);

    // Check at every scroll offset, so each sliver is in the tree at least
    // once during the sweep.
    void checkVisibleTree() {
      for (final forbidden in forbiddenContent) {
        expect(
          find.textContaining(forbidden),
          findsNothing,
          reason: 'محتوى مخترَع ظهر على الشاشة: $forbidden',
        );
      }
    }

    checkVisibleTree();
    for (var i = 0; i < 10; i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -320));
      await tester.pumpAndSettle();
      checkVisibleTree();
    }
  });

  // ── Provenance markers survive the restyle ────────────────────────────────

  testWidgets('يحتفظ بعلامات المصدر والبيانات التجريبية', (tester) async {
    await openPath(tester);

    // Scoped per container: a global findsWidgets would still pass after
    // losing every marker but one.
    expect(
      find.descendant(
        of: find.byType(PathHeroBand),
        matching: find.byType(SourceChip),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(PathOverviewCard),
        matching: find.byType(SourceChip),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(PathOverviewCard),
        matching: find.byType(MockChip),
      ),
      findsOneWidget,
    );

    await scrollTo(tester, find.byType(PathContinueCard));
    expect(
      find.descendant(
        of: find.byType(PathContinueCard),
        matching: find.byType(SourceChip),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(PathContinueCard),
        matching: find.byType(MockChip),
      ),
      findsOneWidget,
    );

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

      // Measure while scrolling: the three buttons live at different offsets,
      // and measuring only at the bottom finds none of them.
      final measured = <String, double>{};
      void measureVisible() {
        for (final type in const [FilledButton, TextButton]) {
          final buttons = find.byType(type);
          for (var i = 0; i < buttons.evaluate().length; i++) {
            final button = buttons.at(i);
            final labels =
                find.descendant(of: button, matching: find.byType(Text));
            final label = labels.evaluate().isEmpty
                ? '$type#$i'
                : (labels.evaluate().first.widget as Text).data ?? '$type#$i';
            measured[label] = tester.getSize(button).height;
          }
        }
      }

      measureVisible();
      for (var i = 0; i < 10; i++) {
        await tester.drag(find.byType(Scrollable).first, const Offset(0, -320));
        await tester.pumpAndSettle();
        measureVisible();
      }

      // Every interactive control on the screen must have been reached, or the
      // assertion below would pass by measuring nothing.
      expect(
        measured.keys,
        containsAll(<String>['تابعي مسارك', 'ادخلي الحلقة', 'تفاصيل تقدّمي']),
        reason: 'لم تُقَس كل الأزرار: ${measured.keys}',
      );
      measured.forEach((label, height) {
        expect(
          height,
          greaterThanOrEqualTo(48.0),
          reason: 'الزر «$label» أصغر من 48dp ($height)',
        );
      });
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
    expect(PathPalette.schemeOf(AppTheme.light.colorScheme).primary,
        AppColors.accentGreen);
    expect(PathPalette.schemeOf(AppTheme.dark.colorScheme).primary,
        AppColors.successDark);
  });

  test('كل تباينات اللوحة المحصورة تجتاز AA في الوضعين', () {
    for (final base in [AppTheme.light.colorScheme, AppTheme.dark.colorScheme]) {
      final s = PathPalette.schemeOf(base);
      final where = 'ثيم ${base.brightness}';

      for (final (name, fg, bg) in [
        ('onPrimary/primary', s.onPrimary, s.primary),
        ('onSurface/surface', s.onSurface, s.surface),
        ('onSurfaceVariant/surface', s.onSurfaceVariant, s.surface),
        (
          'onPrimaryContainer/primaryContainer',
          s.onPrimaryContainer,
          s.primaryContainer
        ),
      ]) {
        expect(_contrast(fg, bg), greaterThanOrEqualTo(4.5),
            reason: '$name في $where');
      }

      // Both pastel tile families, foreground on their own tint.
      for (final tone in PathTileTone.values) {
        final t = PathPalette.tileFor(base.brightness, tone);
        expect(_contrast(t.foreground, t.background),
            greaterThanOrEqualTo(4.5),
            reason: 'بطاقة $tone في $where');
      }

      // The progress arc against its track is non-text contrast (3:1 floor).
      expect(_contrast(s.primary, s.surfaceContainerHighest),
          greaterThanOrEqualTo(3.0),
          reason: 'قوس التقدّم مقابل مساره في $where');
    }
  });

  // ── RTL source lint ───────────────────────────────────────────────────────

  test('ملفات الشاشة الجديدة لا تستخدم يمين/يسار ثابتة', () {
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
    for (final path in screenSourceFiles) {
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
