import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/core/widgets/patterns/halaqa_card.dart';
import 'package:quran_institution_app/core/widgets/patterns/path_stepper.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_notifications_repository.dart';
import 'package:quran_institution_app/features/learning_path/widgets/path_continue_card.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'academic_test_support.dart';

/// The existing screens, unchanged in layout, over real academic data: the
/// real application with API_BASE_URL "set" (backendModeProvider), talking
/// HTTP to a scripted server. What the records hold is shown; what they do
/// not hold — progress, schedules, lessons, a target group — is not drawn,
/// and nothing real is marked as a demo.
void main() {
  late AcademicServer server;
  late ProviderContainer container;

  String location() => container
      .read(routerProvider)
      .routerDelegate
      .currentConfiguration
      .last
      .matchedLocation;

  Future<void> open(
    WidgetTester tester,
    String path, {
    bool signedIn = true,
    bool backend = true,
  }) async {
    // Tall enough that every sliver is built: a "finds nothing" below
    // must mean it is not there, not that it was never laid out.
    tester.view.physicalSize = const Size(390, 6000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final tokens = InMemoryTokenStore();
    if (signedIn) {
      await tokens.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
    }
    container = ProviderContainer(
      overrides: [
        backendModeProvider.overrideWithValue(backend),
        httpClientProvider.overrideWithValue(server.client),
        tokenStoreProvider.overrideWithValue(tokens),
        apiClientProvider.overrideWith(
          (ref) => ApiClient(
            baseUri: Uri.parse('https://api.test/'),
            httpClient: server.client,
            tokenStore: tokens,
            onSignedOut: () => ref.invalidate(sessionUserProvider),
          ),
        ),
        realtimeClientProvider.overrideWithValue(
          const DisabledRealtimeClient(),
        ),
        notificationsRepositoryProvider.overrideWithValue(
          MockNotificationsRepository(latency: Duration.zero, seed: false),
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
    await tester.pump(const Duration(seconds: 3)); // clear the splash timer
    await tester.pumpAndSettle();
    container.read(routerProvider).go(path);
    await tester.pumpAndSettle();
  }

  setUp(() => server = AcademicServer());

  group('against the backend', () {
    testWidgets(
      'home lists the sections the records hold, and counts their halaqat',
      (tester) async {
        server.section('dep-literacy')['name'] = 'قسم محو الأمية للكبار';
        await open(tester, '/home');
        expect(find.text('قسم محو الأمية للكبار'), findsWidgets);
        expect(find.text('45'), findsOneWidget);
        expect(
          server.calls.where((c) => c == 'GET /academic/sections'),
          hasLength(1),
        );
      },
    );

    testWidgets('a program shows its real name and halaqat count', (
      tester,
    ) async {
      await open(tester, '/programs/dep-tajweed-2');
      expect(find.text('قسم تجويد متوسط'), findsWidgets);
      expect(find.text('10 حلقات'), findsWidgets);
      expect(find.text('عرض المسار والمستويات'), findsOneWidget);
    });

    testWidgets(
      'a special section keeps the profile’s own text, marked with its page',
      (tester) async {
        await open(tester, '/programs/sec-kids');
        expect(
          find.textContaining('برامج تعليمية مخصصة للأطفال'),
          findsOneWidget,
        );
        expect(find.text('الملف التعريفي · ص8'), findsWidgets);
        expect(find.text('3 مستويات'), findsWidgets);
      },
    );

    testWidgets(
      'a department’s halaqat are the recorded ones — the learner’s own marked, no progress',
      (tester) async {
        server.enroll(
          'h:dep-tajweed-2-h3',
          teachers: [
            {
              'userId': 't1',
              'displayName': 'الأستاذة عائشة',
              'role': 'TEACHER',
            },
          ],
        );
        await open(tester, '/programs/dep-tajweed-2/levels');
        expect(find.byType(HalaqaCard), findsNWidgets(10));
        expect(find.text('الحلقة 1'), findsOneWidget);
        expect(find.text('الحالية'), findsOneWidget);
        expect(find.text('الأستاذة عائشة'), findsOneWidget);
        expect(find.byType(MockBanner), findsNothing);
        expect(find.byType(MockChip), findsNothing);
        expect(find.text('حلقات مكتملة'), findsNothing);
        expect(find.text('الدروس'), findsNothing);
      },
    );

    testWidgets('a program with no recorded halaqat says so', (tester) async {
      await open(tester, '/programs/prog-nahw/levels');
      expect(find.text('لا توجد حلقات لهذا البرنامج'), findsOneWidget);
    });

    testWidgets(
      'a halaqa shows the enrollment and its teacher — and no invented lessons',
      (tester) async {
        server.enroll(
          'h:dep-tajweed-2-h3',
          teachers: [
            {
              'userId': 't1',
              'displayName': 'الأستاذة عائشة',
              'role': 'TEACHER',
            },
          ],
        );
        await open(tester, '/programs/dep-tajweed-2/levels/h:dep-tajweed-2-h3');
        expect(find.text('الحلقة 3'), findsWidgets);
        expect(find.text('مسجَّلة في هذه الحلقة'), findsOneWidget);
        expect(find.text('الأستاذة عائشة'), findsOneWidget);
        expect(
          find.text('لا توجد دروس أو حضور مسجَّل لهذه الحلقة بعد.'),
          findsOneWidget,
        );
        expect(find.text('الموعد'), findsNothing);
        expect(find.text('فتح المجموعة'), findsNothing);
        expect(find.byType(MockChip), findsNothing);
      },
    );

    testWidgets('a halaqa that does not exist is "not found", not an error', (
      tester,
    ) async {
      await open(tester, '/programs/dep-letters/levels/h:missing');
      expect(find.text('لم نجد هذه الحلقة'), findsOneWidget);
    });

    testWidgets(
      'a refused halaqa shows an error — never a crash, never someone else’s data',
      (tester) async {
        server.refuse['GET /academic/halaqat/h:dep-letters-h1'] = () =>
            refusal(403, 'academic.halaqa_access_denied');
        await open(tester, '/programs/dep-letters/levels/h:dep-letters-h1');
        expect(tester.takeException(), isNull);
        expect(find.text('تعذّر عرض المحتوى'), findsOneWidget);
      },
    );

    group('مساري', () {
      testWidgets(
        'puts the learner where they are enrolled, with no percentage anywhere',
        (tester) async {
          server.enroll(
            'h:dep-tajweed-2-h3',
            teachers: [
              {
                'userId': 't1',
                'displayName': 'الأستاذة عائشة',
                'role': 'TEACHER',
              },
            ],
          );
          await open(tester, '/path');
          final card = find.byType(PathContinueCard);
          expect(card, findsOneWidget);
          expect(
            find.descendant(of: card, matching: find.text('قسم تجويد متوسط')),
            findsOneWidget,
          );
          expect(
            find.descendant(of: card, matching: find.text('الحلقة 3')),
            findsOneWidget,
          );
          expect(
            find.descendant(of: card, matching: find.text('الأستاذة عائشة')),
            findsOneWidget,
          );
          expect(find.textContaining('%'), findsNothing);
          expect(find.textContaining('أتممتِ'), findsNothing);
          expect(find.byType(MockBanner), findsNothing);
          expect(find.byType(MockChip), findsNothing);
          expect(
            find.text('لا يوجد تقدّم أو حضور مسجَّل بعد.'),
            findsOneWidget,
          );
          expect(find.byType(PathStepper), findsOneWidget);
          expect(
            find.text('الحالي'),
            findsNothing,
            reason: 'no invented label',
          );

          await tester.tap(find.text('تابعي مسارك'));
          await tester.pumpAndSettle();
          expect(location(), '/programs/dep-tajweed-2/levels');
        },
      );

      testWidgets(
        'opens the learner’s halaqa from the current-enrollment card',
        (tester) async {
          server.enroll('h:dep-tajweed-2-h3');
          await open(tester, '/path');
          await tester.ensureVisible(find.text('ادخلي الحلقة'));
          await tester.tap(find.text('ادخلي الحلقة'));
          await tester.pumpAndSettle();
          expect(
            location(),
            '/programs/dep-tajweed-2/levels/h:dep-tajweed-2-h3',
          );
        },
      );

      testWidgets(
        'says plainly when there is no current enrollment — nothing "pending"',
        (tester) async {
          await open(tester, '/path');
          expect(find.byType(PathContinueCard), findsNothing);
          expect(
            find.text('لا يوجد تسجيل نشط لكِ في حلقة من حلقات هذه الأقسام.'),
            findsOneWidget,
          );
          expect(find.textContaining('بانتظار'), findsNothing);
          expect(find.text('تابعي مسارك'), findsNothing);
        },
      );

      testWidgets(
        'never takes an enrollment it cannot read the status of for a current one',
        (tester) async {
          server.enroll('h:dep-tajweed-2-h3', status: 'PAUSED');
          await open(tester, '/path');
          expect(find.byType(PathContinueCard), findsNothing);
          expect(
            find.text('لا يوجد تسجيل نشط لكِ في حلقة من حلقات هذه الأقسام.'),
            findsOneWidget,
          );
        },
      );

      testWidgets('asks to sign in when nobody is signed in', (tester) async {
        await open(tester, '/path', signedIn: false);
        expect(find.text('سجّلي الدخول لعرض مسارك'), findsOneWidget);
        expect(find.byType(PathStepper), findsNothing);
        await tester.tap(find.text('تسجيل الدخول'));
        await tester.pumpAndSettle();
        expect(location(), '/sign-in');
      });

      testWidgets('shows an error with retry, and recovers', (tester) async {
        server.refuse['GET /academic/me'] = () => refusal(500, 'internal');
        await open(tester, '/path');
        expect(find.text('تعذّر عرض المحتوى'), findsWidgets);
        expect(find.byType(PathStepper), findsNothing);
        server.refuse.clear();
        await tester.tap(find.text('إعادة المحاولة').first);
        await tester.pumpAndSettle();
        expect(find.byType(PathStepper), findsOneWidget);
        expect(find.text('تعذّر عرض المحتوى'), findsNothing);
      });
    });

    testWidgets('shows a spinner while the halaqat load', (tester) async {
      await open(tester, '/home');
      server.hold = Completer<void>();
      container.read(routerProvider).go('/programs/dep-letters/levels');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.byType(CircularProgressIndicator), findsWidgets);
      expect(find.byType(HalaqaCard), findsNothing);
      server.hold!.complete();
      await tester.pumpAndSettle();
      expect(find.byType(HalaqaCard), findsNWidgets(10));
    });

    testWidgets(
      'progress says nothing is recorded — no zeros, no percentages',
      (tester) async {
        await open(tester, '/progress');
        expect(find.text('لا يوجد تقدّم مسجَّل بعد'), findsOneWidget);
        expect(find.textContaining('%'), findsNothing);
        expect(find.byType(MockBanner), findsNothing);
      },
    );

    testWidgets(
      'the profile is the signed-in account and where it studies — no demo chip',
      (tester) async {
        server.enroll('h:dep-tajweed-2-h3');
        await open(tester, '/profile');
        expect(find.text('مريم'), findsOneWidget);
        expect(find.text('قسم تجويد متوسط'), findsOneWidget);
        expect(find.text('ملف طالبة تجريبي'), findsNothing);
        // No target group is on file for a real account (the demo shows one).
        expect(find.textContaining('الناشئات ·'), findsNothing);
      },
    );

    testWidgets('hides what it does not know how to show', (tester) async {
      server.sections.add({
        ...server.section('sec-kids'),
        'id': 's:future',
        'code': 'future',
        'name': 'قسم لا يعرفه هذا الإصدار',
        'kind': 'SOMETHING_NEW',
      });
      server.section('dep-letters')['status'] = 'ARCHIVED';
      await open(tester, '/home');
      expect(find.text('قسم لا يعرفه هذا الإصدار'), findsNothing);
      expect(find.text('قسم تلقين الحروف'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets(
    'the demo reads the profile’s structure and asks no server anything',
    (tester) async {
      await open(tester, '/path', backend: false, signedIn: false);
      expect(find.byType(MockBanner), findsOneWidget);
      expect(find.byType(PathContinueCard), findsOneWidget);
      container.read(routerProvider).go('/programs/dep-literacy/levels');
      await tester.pumpAndSettle();
      expect(find.byType(HalaqaCard), findsNWidgets(5));
      expect(find.byType(MockChip), findsWidgets);
      expect(server.requests, isEmpty);
    },
  );
}
