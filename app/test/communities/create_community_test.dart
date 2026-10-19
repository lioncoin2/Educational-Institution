import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// In-app community creation (owner decision: enable creation from the app):
/// the entry point is shown only to a holder of `communities.create`
/// (OWNER/ADMIN); a hidden button is a courtesy and the server re-authorises
/// the create. The mock here stands in for the server's success and refusal.
void main() {
  CurrentUser user(Set<String> permissions) => CurrentUser(
    id: viewer,
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: const [],
    permissions: permissions,
  );

  final owner = user({'communities.read', 'communities.create'});
  final student = user({'communities.read'});

  late ScriptedCommunities repo;
  setUp(() => repo = ScriptedCommunities());

  Future<void> openList(WidgetTester tester, CurrentUser signedIn) => openApp(
    tester,
    '/communities',
    overrides: [
      communityRepositoryProvider.overrideWithValue(repo),
      sessionUserProvider.overrideWith((ref) async => signedIn),
    ],
  );

  testWidgets('shows the create button to a holder of communities.create', (
    tester,
  ) async {
    await openList(tester, owner);
    expect(find.byKey(const Key('create-community-fab')), findsOneWidget);
  });

  testWidgets('hides the create button from anyone without it', (tester) async {
    await openList(tester, student);
    expect(find.byKey(const Key('create-community-fab')), findsNothing);
  });

  testWidgets(
    'creates a community — the server is asked, and the sheet closes',
    (tester) async {
      await openList(tester, owner);
      await tester.tap(find.byKey(const Key('create-community-fab')));
      await tester.pumpAndSettle();

      // An empty title keeps the submit disabled.
      final submit = find.byKey(const Key('create-community-submit'));
      expect(tester.widget<ButtonStyleButton>(submit).onPressed, isNull);

      await tester.enterText(
        find.byKey(const Key('create-community-title')),
        'حلقة جديدة',
      );
      await tester.pump();
      expect(tester.widget<ButtonStyleButton>(submit).onPressed, isNotNull);

      await tester.tap(submit);
      await tester.pumpAndSettle();

      // A group by default (ADR 0039).
      expect(repo.writes, contains('create حلقة جديدة GROUP'));
      expect(find.text(CommunityCopy.communityCreated), findsOneWidget);
      // The sheet closed.
      expect(find.byKey(const Key('create-community-title')), findsNothing);
    },
  );

  testWidgets(
    'creates a channel when the channel kind is chosen (ADR 0039)',
    (tester) async {
      await openList(tester, owner);
      await tester.tap(find.byKey(const Key('create-community-fab')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('create-community-title')),
        'إعلانات',
      );
      // Choose «قناة» in the kind selector, then create.
      await tester.tap(find.text(CommunityCopy.communityKindChannel));
      await tester.pump();
      await tester.tap(find.byKey(const Key('create-community-submit')));
      await tester.pumpAndSettle();

      expect(repo.writes, contains('create إعلانات CHANNEL'));
      expect(find.text(CommunityCopy.communityCreated), findsOneWidget);
    },
  );

  testWidgets('a refused create is said in words, and the sheet stays open', (
    tester,
  ) async {
    await openList(tester, owner);
    await tester.tap(find.byKey(const Key('create-community-fab')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('create-community-title')),
      'حلقة جديدة',
    );
    await tester.pump();

    repo.failWritesWith = 'communities.title_invalid';
    await tester.tap(find.byKey(const Key('create-community-submit')));
    await tester.pumpAndSettle();

    expect(
      find.text(CommunityCopy.writeFailed('communities.title_invalid')),
      findsOneWidget,
    );
    // Still open for a correction.
    expect(find.byKey(const Key('create-community-title')), findsOneWidget);
  });
}
