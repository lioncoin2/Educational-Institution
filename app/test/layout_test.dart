import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Renders every screen of the student journey at four viewport / text-scale
/// combinations. A RenderFlex overflow throws in debug builds, so any of these
/// failing means a real layout break — this is the automated stand-in for
/// resizing the browser by hand.

class _Viewport {
  const _Viewport(this.name, this.size, this.textScale);

  final String name;
  final Size size;
  final double textScale;
}

const _viewports = [
  _Viewport('هاتف صغير', Size(360, 690), 1.0),
  _Viewport('هاتف صغير · خط أكبر', Size(360, 690), 1.3),
  _Viewport('لوحي', Size(768, 1024), 1.0),
  _Viewport('سطح مكتب', Size(1280, 900), 1.0),
];

/// Every route of the implemented journey, including the deep ones. The second
/// value is a string that must be on screen: a route that renders an empty
/// body throws no exception, so "no overflow" alone is not enough of a check.
const _routes = <String, (String, String)>{
  '/home': ('الرئيسية', 'مرحباً'),
  '/programs': ('البرامج', 'البرامج التعليمية'),
  '/programs/dep-tajweed-2': ('تفاصيل قسم', 'عرض المسار والمستويات'),
  '/programs/sec-spelling': ('تفاصيل قسم التهجي', 'استيعاب 40 مجموعة'),
  '/programs/sec-languages': ('تفاصيل قسم اللغات', 'اللغات'),
  '/programs/prog-mutun': ('تفاصيل المتون', 'المتون'),
  '/programs/prog-maqari': (
    'برنامج بلا مستويات',
    'لا توجد مستويات مذكورة في الملف',
  ),
  '/programs/dep-tajweed-2/levels': ('المستويات', 'حلقات مكتملة'),
  '/programs/dep-tajweed-2/levels/dep-tajweed-2-h5': ('الحلقة', 'المعلّمة'),
  '/programs/dep-tajweed-2/levels/dep-tajweed-2-h5/lessons/dep-tajweed-2-h5-l4':
      ('الدرس', 'المقطع المقرّر'),
  '/path': ('المسار', 'المنهج المتدرّج'),
  '/progress': ('التقدّم', 'مدينة الحفاظ'),
  '/certificates': ('الشهادات', 'صادرة'),
  '/certificates/c1': ('تفاصيل شهادة', 'رقم التوثيق'),
  '/certificates/c6': ('شهادة قيد الإصدار', 'قيد الإصدار'),
  '/profile': ('الحساب', 'ملف طالبة تجريبي'),
  '/notifications': ('الإشعارات', 'لديك رسالة جديدة من الأستاذ عبدالله.'),
  '/notifications/settings': ('إعدادات الإشعارات', 'داخل التطبيق'),
  '/announcements': ('الإعلانات', 'قسم الإعلام والإعلان والتصاميم'),
  '/messages': ('الرسائل', 'حلقة الفجر — التلاوة'),
  '/messages/mock-group': ('محادثة جماعية', 'الأستاذ عبدالله'),
  '/messages/mock-direct': ('محادثة خاصة', 'قبل الخميس'),
  '/messages/mock-channel': ('قناة إعلانات', 'يمكنك القراءة فقط'),
  '/communities': ('مجتمعاتي', 'مجتمع طلاب التجويد'),
  '/communities/mock-community-family': ('مجتمع', 'مالك المجتمع'),
  '/communities/mock-community-institute/members': (
    'أعضاء مجتمع',
    'الأستاذ عبدالله',
  ),
  '/communities/mock-community-family/invitations': (
    'روابط دعوة مجتمع',
    'مرات الاستخدام',
  ),
  '/invite': ('دعوة إلى مجتمع', 'لا توجد دعوة لفتحها'),
  '/sign-in': ('تسجيل الدخول', 'أدخل بيانات حسابك في المعهد'),
};

void main() {
  for (final viewport in _viewports) {
    group('${viewport.name} (${viewport.size.width.toInt()}×'
        '${viewport.size.height.toInt()} · خط ${viewport.textScale})', () {
      for (final entry in _routes.entries) {
        testWidgets('${entry.value.$1} — ${entry.key}', (tester) async {
          tester.view.physicalSize = viewport.size;
          tester.view.devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);

          final container = ProviderContainer(
            overrides: [
              textScaleProvider.overrideWith(
                () => _FixedTextScale(viewport.textScale),
              ),
            ],
          );
          addTearDown(container.dispose);

          await tester.pumpWidget(
            UncontrolledProviderScope(
              container: container,
              child: const QuranInstitutionApp(),
            ),
          );

          // Clear the splash timer before navigating.
          await tester.pump(const Duration(seconds: 3));
          await tester.pumpAndSettle();

          container.read(routerProvider).go(entry.key);
          await tester.pumpAndSettle();

          expect(tester.takeException(), isNull);

          // The screen must actually have rendered something.
          expect(
            find.textContaining(entry.value.$2),
            findsWidgets,
            reason: 'الشاشة ${entry.key} ظهرت فارغة',
          );

          // Scroll to the bottom to exercise off-screen content too.
          final scrollable = find.byType(Scrollable);
          if (scrollable.evaluate().isNotEmpty) {
            await tester.drag(scrollable.first, const Offset(0, -2000));
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
          }
        });
      }
    });
  }
}

class _FixedTextScale extends TextScaleNotifier {
  _FixedTextScale(this.value);

  final double value;

  @override
  double build() => value;
}
