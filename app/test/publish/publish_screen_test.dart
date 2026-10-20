import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/publication.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/publish/publish_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

class _FakeCommunities implements CommunityRepository {
  @override
  Future<CommunityPage> communities({String? cursor}) async => CommunityPage(
    items: [
      Community.fromJson(const {
        'id': 'c1',
        'title': 'حلقة التجويد',
        'status': 'ACTIVE',
        'lifecycleVersion': 1,
        'memberCount': 3,
        'createdAt': '2026-01-01T00:00:00Z',
      }),
      Community.fromJson(const {
        'id': 'c2',
        'title': 'حلقة الحفظ',
        'status': 'ACTIVE',
        'lifecycleVersion': 1,
        'memberCount': 4,
        'createdAt': '2026-01-01T00:00:00Z',
      }),
    ],
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _FakeMessaging implements MessagingRepository {
  _FakeMessaging(this._scripted);
  int calls = 0;
  final PublicationReport Function(int index, List<String> ids) _scripted;

  @override
  Future<PublicationReport> publishToCommunities({
    required String clientBatchId,
    required List<String> communityIds,
    required String kind,
    String? body,
    String? fileAssetId,
  }) async {
    final report = _scripted(calls, communityIds);
    calls += 1;
    return report;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

PublicationReport _report(Map<String, PublicationStatus> byId) =>
    PublicationReport(
      batchId: 'b',
      results: [
        for (final e in byId.entries)
          PublicationOutcome(
            communityId: e.key,
            status: e.value,
            retryable: e.value == PublicationStatus.unavailable,
            messageId: e.value.isSuccess ? 'm' : null,
          ),
      ],
    );

Future<void> pump(WidgetTester tester, MessagingRepository messaging) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        communityRepositoryProvider.overrideWithValue(_FakeCommunities()),
        messagingRepositoryProvider.overrideWithValue(messaging),
      ],
      child: MaterialApp(
        home: const PublishScreen(),
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'composes, targets, publishes and shows the per-community result',
    (tester) async {
      final messaging = _FakeMessaging(
        (_, _) => _report({'c1': PublicationStatus.posted}),
      );
      await pump(tester, messaging);

      // The publish button is disabled until there is content and a target.
      final publishButton = find.widgetWithText(FilledButton, 'نشر');
      expect(tester.widget<FilledButton>(publishButton).onPressed, isNull);

      await tester.enterText(find.byType(TextField), 'تذكير بالدرس');
      await tester.tap(find.byKey(const Key('publish-target-c1')));
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(publishButton).onPressed, isNotNull);

      await tester.tap(publishButton);
      await tester.pumpAndSettle();

      expect(messaging.calls, 1);
      expect(find.text('نُشر في 1 من 1.'), findsOneWidget);
      expect(find.text('تم النشر'), findsOneWidget);
      // No retry affordance when nothing is retryable.
      expect(find.byKey(const Key('publish-retry-failed')), findsNothing);
    },
  );

  testWidgets('offers a retry for a transient failure and resends it', (
    tester,
  ) async {
    final messaging = _FakeMessaging((index, ids) {
      if (index == 0) {
        return _report({
          'c1': PublicationStatus.posted,
          'c2': PublicationStatus.unavailable,
        });
      }
      return _report({'c2': PublicationStatus.posted});
    });
    await pump(tester, messaging);

    await tester.enterText(find.byType(TextField), 'إعلان');
    await tester.tap(find.byKey(const Key('publish-target-c1')));
    await tester.tap(find.byKey(const Key('publish-target-c2')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'نشر'));
    await tester.pumpAndSettle();

    expect(find.text('نُشر في 1 من 2، تعذّر 1.'), findsOneWidget);
    final retry = find.byKey(const Key('publish-retry-failed'));
    expect(retry, findsOneWidget);

    await tester.ensureVisible(retry);
    await tester.pumpAndSettle();
    await tester.tap(retry);
    await tester.pumpAndSettle();

    expect(messaging.calls, 2);
    expect(find.text('نُشر في 1 من 1.'), findsOneWidget);
  });
}
