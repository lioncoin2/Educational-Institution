import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// BUG-2 regression. Tapping a community row in the communities list opens its
/// CONVERSATION directly — the same canonical resolve the in-chat header and the
/// community page's "open chat" button use — never the community
/// management/detail ("settings") page. The community page is reached
/// deliberately from the conversation header, not as the default on tap. A
/// refused chat opens nothing and leaves the viewer on the list.
void main() {
  const owned = MockCommunityRepository.ownedId;
  const signedIn = CurrentUser(
    id: viewer,
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: [],
    permissions: {},
  );

  late ProviderContainer container;

  Future<void> start(WidgetTester tester, {ScriptedMessaging? messaging}) async {
    container = await openApp(
      tester,
      '/communities',
      size: const Size(390, 2000),
      overrides: [
        communityRepositoryProvider.overrideWithValue(ScriptedCommunities()),
        messagingRepositoryProvider.overrideWithValue(
          messaging ?? ScriptedMessaging(),
        ),
        sessionUserProvider.overrideWith((ref) async => signedIn),
      ],
    );
  }

  String location() => locationIn(container);

  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  testWidgets('a community row opens its conversation, not its settings page', (
    tester,
  ) async {
    await start(tester);
    final row = find.byKey(const ValueKey(owned));
    expect(row, findsOneWidget);
    await tester.ensureVisible(row);
    await tester.tap(row);
    await frames(tester);
    // The conversation route — never the community management/detail route.
    expect(location(), '/messages/${chatOf(owned)}');
    expect(location(), isNot('/communities/$owned'));
  });

  testWidgets('a refused chat opens nothing and stays on the list', (
    tester,
  ) async {
    await start(
      tester,
      messaging: ScriptedMessaging()
        ..chatLookupFailure = 'messaging.conversation_not_found',
    );
    final row = find.byKey(const ValueKey(owned));
    await tester.ensureVisible(row);
    await tester.tap(row);
    await frames(tester);
    // No navigation on a refusal: the opener says so in a toast and opens nothing.
    expect(location(), '/communities');
  });

  // Improvement 3: the withCanPost test helper changes only canPost and
  // preserves every other field — including the community kind (so a group
  // chat's header stays a group) and the pin state.
  test('withCanPost preserves communityKind and pin state', () {
    final original = Conversation(
      id: 'c1',
      type: ConversationType.channel,
      title: 'الحلقة',
      memberCount: 7,
      myRole: ParticipantRole.member,
      canPost: false,
      canManageMembers: false,
      lastSequence: 3,
      lastReadSequence: 1,
      unreadCount: 2,
      createdAt: DateTime.utc(2026),
      activityAt: DateTime.utc(2026),
      communityId: 'com-1',
      communityKind: CommunityKind.group,
      pinnedMessageId: 'm-9',
      pinVersion: 4,
    );
    final flipped = withCanPost(original, true);
    expect(flipped.canPost, isTrue);
    expect(flipped.communityKind, CommunityKind.group);
    expect(flipped.communityId, 'com-1');
    expect(flipped.pinnedMessageId, 'm-9');
    expect(flipped.pinVersion, 4);
  });
}
