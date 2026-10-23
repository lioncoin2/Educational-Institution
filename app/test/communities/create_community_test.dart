import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
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

  Future<ProviderContainer> openList(
    WidgetTester tester,
    CurrentUser signedIn,
  ) => openApp(
    tester,
    '/communities',
    overrides: [
      communityRepositoryProvider.overrideWithValue(repo),
      // The created community's chat resolves (as the real backend materialises
      // it on demand), so opening its primary view can be verified.
      messagingRepositoryProvider.overrideWithValue(_OpensAnyCommunityChat()),
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
    'creates a community — the server is asked, and its conversation opens',
    (tester) async {
      final container = await openList(tester, owner);
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
      // The sheet closed and the new community's PRIMARY view — its
      // conversation, by the created id — opened (never its settings page).
      expect(find.byKey(const Key('create-community-title')), findsNothing);
      expect(locationIn(container), '/messages/mock-community-new-1-chat');
    },
  );

  testWidgets(
    'creates a channel when the channel kind is chosen (ADR 0039), and opens it',
    (tester) async {
      final container = await openList(tester, owner);
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
      expect(locationIn(container), '/messages/mock-community-new-1-chat');
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

/// A messaging stand-in that resolves ANY community's chat (as the real backend
/// materialises a community chat on demand), so opening a just-created
/// community's primary view can be exercised in a widget test.
class _OpensAnyCommunityChat extends MockMessagingRepository {
  _OpensAnyCommunityChat() : super(latency: Duration.zero);

  @override
  Future<Conversation> conversationForCommunity(String communityId) async =>
      _chatFor(communityId);

  @override
  Future<Conversation> conversation(String conversationId) async => _chatFor(
    conversationId.endsWith('-chat')
        ? conversationId.substring(0, conversationId.length - '-chat'.length)
        : conversationId,
  );

  Conversation _chatFor(String communityId) => Conversation(
    id: '$communityId-chat',
    type: ConversationType.group,
    title: 'حلقة جديدة',
    memberCount: 1,
    myRole: ParticipantRole.member,
    canPost: true,
    canManageMembers: false,
    lastSequence: 0,
    lastReadSequence: 0,
    unreadCount: 0,
    createdAt: DateTime.utc(2026, 9),
    activityAt: DateTime.utc(2026, 9),
    communityId: communityId,
  );
}
