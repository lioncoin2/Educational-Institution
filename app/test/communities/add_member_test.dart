import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// Adding (or re-adding) a member (Owner Decision A1/A4): the action is offered
/// only when the server's `me` grants `community.members.invite`; the picker
/// searches people (the demo repo here; the server gates `/people` on
/// `people.read`) and the add is the server's decision on the id.
void main() {
  const owned = MockCommunityRepository.ownedId; // the viewer owns it → members.invite
  const delegated = MockCommunityRepository.delegatedId; // members.view only

  const signedIn = CurrentUser(
    id: viewer,
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: [],
    permissions: {},
  );

  late ScriptedCommunities repo;

  Future<void> openMembers(
    WidgetTester tester,
    String communityId, {
    List<Override> extra = const [],
  }) async {
    await openApp(
      tester,
      '/communities/$communityId/members',
      size: const Size(390, 2000),
      overrides: [
        communityRepositoryProvider.overrideWithValue(repo),
        sessionUserProvider.overrideWith((ref) async => signedIn),
        ...extra,
      ],
    );
  }

  setUp(() => repo = ScriptedCommunities());

  testWidgets('offers Add member to a holder of community.members.invite', (tester) async {
    await openMembers(tester, owned);
    expect(find.byKey(const Key('community-add-member')), findsOneWidget);
  });

  testWidgets('offers no Add member to a viewer who may only view members', (tester) async {
    await openMembers(tester, delegated);
    expect(find.byKey(const Key('community-add-member')), findsNothing);
  });

  testWidgets('searches people and adds one — the server is asked, the sheet closes', (
    tester,
  ) async {
    await openMembers(tester, owned);
    await tester.tap(find.byKey(const Key('community-add-member')));
    await tester.pumpAndSettle();
    expect(find.text(CommunityCopy.addMemberPrompt), findsOneWidget);

    await tester.enterText(find.byKey(const Key('add-member-search')), 'سا');
    await tester.pump(const Duration(milliseconds: 350)); // the search debounce
    await tester.pumpAndSettle();
    // The demo people repo answers "سا" with سارة / سلمى.
    expect(find.byKey(const Key('add-member-mock-person-sara')), findsOneWidget);

    await tester.tap(find.byKey(const Key('add-member-mock-person-sara')));
    await tester.pumpAndSettle();

    expect(repo.writes, contains('addMembers $owned mock-person-sara'));
    expect(find.text(CommunityCopy.memberAdded), findsOneWidget);
    expect(find.byKey(const Key('add-member-search')), findsNothing); // sheet closed
  });

  testWidgets('a refused add is said in words, and the sheet stays open', (tester) async {
    await openMembers(tester, owned);
    await tester.tap(find.byKey(const Key('community-add-member')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('add-member-search')), 'سا');
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();

    repo.failWritesWith = 'communities.too_many_additions';
    await tester.tap(find.byKey(const Key('add-member-mock-person-sara')));
    await tester.pumpAndSettle();

    expect(
      find.text(CommunityCopy.writeFailed('communities.too_many_additions')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('add-member-search')), findsOneWidget); // still open
  });
}
