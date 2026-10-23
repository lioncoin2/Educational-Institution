import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// BUG-3 (widget + mock). The conversation header subtitle names a community
/// chat by its product kind — a group reads "group" even though its transport
/// `type` is CHANNEL for every community chat (Q51) — while a genuine channel,
/// an unknown kind, and a non-community conversation keep the transport label.
///
/// The widget tests render the REAL [ConversationScreen] header (not the copy
/// function in isolation) and assert the subtitle text, which is a stable
/// contract — not an incidental layout detail.

/// A messaging repository that returns exactly one crafted conversation, so the
/// header can be exercised for a kind the all-group demo data cannot produce (a
/// channel community). An empty timeline means the screen never marks-read.
class _HeaderRepo extends MockMessagingRepository {
  _HeaderRepo(this.conversationView) : super(latency: Duration.zero);

  final Conversation conversationView;

  @override
  Future<Conversation> conversation(String conversationId) async =>
      conversationView;

  @override
  Future<MessagePage> messages(
    String conversationId, {
    int? before,
    int? after,
    int limit = 30,
  }) async => const MessagePage(
    items: [],
    hasOlder: false,
    hasNewer: false,
    lastReadSequence: 0,
  );
}

Conversation _conv({
  required String id,
  required ConversationType type,
  String? communityId,
  CommunityKind? communityKind,
  required int memberCount,
}) => Conversation(
  id: id,
  type: type,
  title: 'الحلقة',
  memberCount: memberCount,
  myRole: ParticipantRole.member,
  canPost: false,
  canManageMembers: false,
  lastSequence: 0,
  lastReadSequence: 0,
  unreadCount: 0,
  createdAt: DateTime.utc(2026),
  activityAt: DateTime.utc(2026),
  communityId: communityId,
  communityKind: communityKind,
  origin: DataOrigin.mock,
);

Future<void> _openHeader(WidgetTester tester, Conversation conversation) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final container = ProviderContainer(
    overrides: [
      messagingRepositoryProvider.overrideWithValue(_HeaderRepo(conversation)),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const QuranInstitutionApp(),
    ),
  );
  await tester.pump(const Duration(seconds: 3)); // the splash timer
  await tester.pumpAndSettle();
  container.read(routerProvider).go('/messages/${conversation.id}');
  await tester.pumpAndSettle();
}

void main() {
  // A real demo community id, so the header's community providers resolve.
  const community = MockCommunityRepository.openId;

  testWidgets('a GROUP community chat shows the group label, not channel', (
    tester,
  ) async {
    await _openHeader(
      tester,
      _conv(
        id: 'hk-group',
        type: ConversationType.channel, // transport is CHANNEL for all community chats (Q51)
        communityId: community,
        communityKind: CommunityKind.group,
        memberCount: 7,
      ),
    );
    expect(find.text('مجموعة · 7 عضوًا'), findsOneWidget);
    expect(find.text('قناة · 7 مشتركًا'), findsNothing);
  });

  testWidgets('a CHANNEL community chat shows the channel label', (
    tester,
  ) async {
    await _openHeader(
      tester,
      _conv(
        id: 'hk-channel',
        type: ConversationType.channel,
        communityId: community,
        communityKind: CommunityKind.channel,
        memberCount: 9,
      ),
    );
    expect(find.text('قناة · 9 مشتركًا'), findsOneWidget);
  });

  testWidgets('an unknown kind on a community chat falls back to the type label', (
    tester,
  ) async {
    await _openHeader(
      tester,
      _conv(
        id: 'hk-unknown',
        type: ConversationType.channel,
        communityId: community,
        communityKind: null, // server did not say
        memberCount: 5,
      ),
    );
    // Falls back to the CHANNEL transport label — a real channel is never
    // mislabelled a group when the kind is unknown.
    expect(find.text('قناة · 5 مشتركًا'), findsOneWidget);
  });

  testWidgets('a non-community conversation keeps its type label', (
    tester,
  ) async {
    await _openHeader(
      tester,
      _conv(
        id: 'hk-direct-group',
        type: ConversationType.group,
        memberCount: 4,
      ),
    );
    expect(find.text('مجموعة · 4 أعضاء'), findsOneWidget);
  });

  // Improvement 1: the demo mock populates communityKind on community chats
  // (all demo communities are groups) and leaves non-community chats null.
  test('demo mock gives community chats the group kind and others none', () async {
    final repo = MockMessagingRepository(latency: Duration.zero);
    final groupChat = await repo.conversation(
      '${MockCommunityRepository.openId}-chat',
    );
    expect(groupChat.isCommunityChat, isTrue);
    expect(groupChat.communityKind, CommunityKind.group);

    final standaloneChannel = await repo.conversation('mock-channel');
    expect(standaloneChannel.isCommunityChat, isFalse);
    expect(standaloneChannel.communityKind, isNull);

    final direct = await repo.conversation('mock-direct');
    expect(direct.communityKind, isNull);
  });
}
