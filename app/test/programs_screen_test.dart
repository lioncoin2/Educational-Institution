import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/theme/app_colors.dart';
import 'package:quran_institution_app/data/sources/profile_data.dart';
import 'package:quran_institution_app/features/programs/widgets/program_field_card.dart';
import 'package:quran_institution_app/features/programs/widgets/programs_header.dart';
import 'package:quran_institution_app/features/programs/widgets/programs_hero.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Tests for the reference-faithful Programs screen: it renders the six real
/// study fields, never leaks the reference's invented categories, filters
/// client-side, navigates into the real catalogue, and confines the green.

const programsSourceFiles = [
  'lib/features/programs/programs_screen.dart',
  'lib/features/programs/widgets/programs_header.dart',
  'lib/features/programs/widgets/programs_hero.dart',
  'lib/features/programs/widgets/programs_search_bar.dart',
  'lib/features/programs/widgets/programs_grid.dart',
  'lib/features/programs/widgets/program_field_card.dart',
  'lib/features/programs/widgets/programs_bottom_cta.dart',
];

/// Reference categories that are NOT in this institution's profile.
const forbiddenContent = [
  'علوم القرآن',
  'العقيدة والفقه',
  'المهارات الحياتية',
  'البرامج المساندة',
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

  Future<void> openPrograms(
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
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    container.read(routerProvider).go('/programs');
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

  // ── Rendering & overflow ────────────────────────────────────────────────
  for (final (label, size, scale) in const [
    ('هاتف صغير', Size(360, 690), 1.0),
    ('هاتف صغير · خط أكبر', Size(360, 690), 1.3),
    ('لوحي', Size(768, 1024), 1.0),
  ]) {
    testWidgets('يُرسم بلا تجاوز — $label', (tester) async {
      await openPrograms(tester, size: size, textScale: scale);
      expect(tester.takeException(), isNull);
      expect(find.byType(ProgramsHeader), findsOneWidget);
      expect(find.byType(ProgramsHero), findsOneWidget);
      for (var i = 0; i < 6; i++) {
        await tester.drag(find.byType(Scrollable).first, const Offset(0, -260));
        await tester.pumpAndSettle();
      }
      expect(tester.takeException(), isNull);
    });
  }

  // ── The six real study fields ────────────────────────────────────────────
  testWidgets('يعرض المجالات الستة الحقيقية', (tester) async {
    await openPrograms(tester);
    expect(ProfileData.studyFields.length, 6);
    for (final field in ProfileData.studyFields) {
      await scrollTo(tester, find.text(field.name));
      expect(find.text(field.name), findsOneWidget,
          reason: 'المجال ${field.name} غير موجود');
    }
    expect(find.byType(ProgramFieldCard), findsNWidgets(6));
  });

  testWidgets('الترويسة تحمل عنوان الشاشة', (tester) async {
    await openPrograms(tester);
    expect(
      find.descendant(
          of: find.byType(ProgramsHeader),
          matching: find.text('البرامج التعليمية')),
      findsOneWidget,
    );
  });

  // ── No invented content ──────────────────────────────────────────────────
  test('ملفات الشاشة لا تحتوي فئات الصورة المخترَعة', () {
    for (final path in programsSourceFiles) {
      final source = File(path).readAsStringSync();
      for (final forbidden in forbiddenContent) {
        expect(source.contains(forbidden), isFalse,
            reason: 'محتوى مخترَع في $path: $forbidden');
      }
    }
  });

  testWidgets('لا يظهر أي محتوى مخترَع', (tester) async {
    await openPrograms(tester);
    for (var i = 0; i < 6; i++) {
      for (final forbidden in forbiddenContent) {
        expect(find.textContaining(forbidden), findsNothing,
            reason: 'محتوى مخترَع ظهر: $forbidden');
      }
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -260));
      await tester.pumpAndSettle();
    }
  });

  // ── Client-side search ───────────────────────────────────────────────────
  testWidgets('البحث يصفّي البطاقات محلياً', (tester) async {
    await openPrograms(tester);
    expect(find.byType(ProgramFieldCard), findsNWidgets(6));
    await tester.enterText(find.byType(TextField), 'التجويد');
    await tester.pumpAndSettle();
    expect(find.byType(ProgramFieldCard), findsOneWidget);
    expect(find.text('التجويد والقراءات'), findsOneWidget);
  });

  // ── Navigation into the real catalogue ───────────────────────────────────
  testWidgets('بطاقة المجال تفتح برنامجاً حقيقياً', (tester) async {
    await openPrograms(tester);
    await scrollTo(tester, find.text('التجويد والقراءات'));
    await tester.tap(find.text('التجويد والقراءات'));
    await tester.pumpAndSettle();
    expect(location(), '/programs/dep-tajweed-2');
  });

  testWidgets('زر «استكشف البرامج» يفتح برنامجاً', (tester) async {
    await openPrograms(tester);
    await scrollTo(tester, find.text('استكشف البرامج'));
    await tester.tap(find.text('استكشف البرامج'));
    await tester.pumpAndSettle();
    expect(location(), '/programs/dep-literacy');
  });

  // Every field card must resolve to a REAL program id — a typo in the map
  // would silently route to the not-found screen while other tests stayed green.
  testWidgets('كل بطاقة مجال تفتح برنامجاً موجوداً', (tester) async {
    const expected = <String, String>{
      'القرآن حفظاً وإتقاناً': '/programs/prog-hifz-city',
      'العلوم الشرعية': '/programs/prog-maqari',
      'التجويد والقراءات': '/programs/dep-tajweed-2',
      'علوم اللغة والنحو': '/programs/prog-nahw',
      'قسم المتون العلمية': '/programs/prog-mutun',
      'قسم التعليم الدولي': '/programs/sec-languages',
    };
    await openPrograms(tester);
    for (final entry in expected.entries) {
      container.read(routerProvider).go('/programs');
      await tester.pumpAndSettle();
      await scrollTo(tester, find.text(entry.key));
      await tester.tap(find.text(entry.key));
      await tester.pumpAndSettle();
      expect(location(), entry.value, reason: entry.key);
      // The destination is a real program, not the not-found screen.
      expect(find.textContaining('لم نجد'), findsNothing, reason: entry.key);
    }
  });

  // ── Green scoped, no leak into the shared nav ────────────────────────────
  testWidgets('الأخضر محصور في البرامج ولا يتسرّب للهيكل المشترك',
      (tester) async {
    await openPrograms(tester);
    final headerContext = tester.element(find.byType(ProgramsHeader));
    expect(Theme.of(headerContext).colorScheme.primary, AppColors.accentGreen);

    final nav = tester.widget<NavigationBar>(find.byType(NavigationBar));
    final navContext = tester.element(find.byType(NavigationBar));
    // The shared nav keeps the plum scheme.
    expect(Theme.of(navContext).colorScheme.primary, AppColors.primary);
    expect(nav.selectedIndex, isNotNull);
  });

  // ── Tap targets ──────────────────────────────────────────────────────────
  testWidgets('أهداف اللمس لا تقل عن 48dp', (tester) async {
    await openPrograms(tester, size: const Size(360, 690));
    final measured = <String, Size>{};
    void measure() {
      for (final type in const [FilledButton, IconButton]) {
        final b = find.byType(type);
        for (var i = 0; i < b.evaluate().length; i++) {
          final size = tester.getSize(b.at(i));
          measured['$type#${size.width.toInt()}x${size.height.toInt()}'] = size;
        }
      }
    }

    measure();
    for (var i = 0; i < 6; i++) {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -260));
      await tester.pumpAndSettle();
      measure();
    }
    expect(measured, isNotEmpty);
    measured.forEach((k, size) {
      expect(size.height, greaterThanOrEqualTo(48.0), reason: '$k ارتفاع < 48');
      if (k.startsWith('IconButton')) {
        expect(size.width, greaterThanOrEqualTo(48.0), reason: '$k عرض < 48');
      }
    });
  });

  // ── RTL source lint ──────────────────────────────────────────────────────
  test('ملفات البرامج لا تستخدم يمين/يسار ثابتة', () {
    const forbidden = [
      'EdgeInsets.only(left:', 'EdgeInsets.only(right:',
      'Alignment.centerLeft', 'Alignment.centerRight',
      'Alignment.topLeft', 'Alignment.topRight',
      'Alignment.bottomLeft', 'Alignment.bottomRight',
      'Positioned(left:', 'Positioned(right:', 'chevron_left',
    ];
    for (final path in programsSourceFiles) {
      final source = File(path).readAsStringSync();
      for (final token in forbidden) {
        expect(source.contains(token), isFalse,
            reason: '$path يحتوي على "$token" وهو يكسر RTL');
      }
    }
  });
}
