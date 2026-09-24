import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_controller.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_list_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'community_test_support.dart';

/// A community's chat is an ordinary conversation that follows its
/// community. Messaging's state learns of that only through the community's
/// frames — and treats them as a reason to ask the server again: a chat is
/// closed only when the server refuses it, and posting follows the server's
/// `canPost`, never a frame.
void main() {
  const community = MockCommunityRepository.ownedId;
  final chat = chatOf(community);

  late ScriptedMessaging repo;
  late FakeRealtimeClient realtime;
  late ProviderContainer container;

  void boot() {
    container = ProviderContainer(
      overrides: [
        messagingRepositoryProvider.overrideWithValue(repo),
        realtimeConnectionProvider.overrideWithValue(realtime),
      ],
    );
    addTearDown(container.dispose);
  }

  setUp(() {
    repo = ScriptedMessaging();
    realtime = FakeRealtimeClient();
    boot();
  });

  group('an open community chat', () {
    Future<ConversationState> load(String id) async {
      final keepAlive = container.listen(conversationProvider(id), (_, _) {});
      addTearDown(keepAlive.close);
      final state = await container.read(conversationProvider(id).future);
      await pumpEventQueue(); // the first subscribe, once on screen
      return state;
    }

    ConversationState current(String id) =>
        container.read(conversationProvider(id)).requireValue;

    test('knows its community', () async {
      final state = await load(chat);
      expect(state.conversation.communityId, community);
      expect(state.conversation.canPost, isTrue);
    });

    test(
      'closes only when the server refuses it after a removal frame',
      () async {
        await load(chat);
        realtime.subscriptions.clear();
        realtime.onSubscribe = (_) =>
            const SubscriptionRefused(RealtimeErrorCode.conversationNotFound);
        realtime.emit(removed(community));
        await pumpEventQueue();
        expect(realtime.subscriptions, [chat]);
        expect(current(chat).removed, isTrue);
      },
    );

    test('stays open when the server still admits the viewer', () async {
      await load(chat);
      realtime.subscriptions.clear();
      realtime.onSubscribe = (_) =>
          const Subscribed(lastSequence: 1, lastReadSequence: 1);
      realtime.emit(removed(community));
      await pumpEventQueue();
      expect(realtime.subscriptions, [chat]);
      expect(current(chat).removed, isFalse);
    });

    test(
      'asks for canPost again on a lock, an unlock or changed access',
      () async {
        await load(chat);
        expect(current(chat).conversation.canPost, isTrue);

        repo.canPostOverride[chat] = false;
        realtime.emit(locked(community, 2));
        await pumpEventQueue();
        expect(current(chat).conversation.canPost, isFalse);

        repo.canPostOverride[chat] = true;
        realtime.emit(unlocked(community, 3));
        await pumpEventQueue();
        expect(current(chat).conversation.canPost, isTrue);

        repo.canPostOverride[chat] = false;
        realtime.emit(accessChanged(community));
        await pumpEventQueue();
        expect(current(chat).conversation.canPost, isFalse);
        expect(
          repo.conversationRequests.where((id) => id == chat),
          hasLength(4),
        );
        // The timeline itself is untouched by the re-read.
        expect(current(chat).messages, isNotEmpty);
      },
    );

    test(
      'asks for canPost again once loaded, for a lock that came meanwhile',
      () async {
        // The conversation read takes its answer: the viewer may post...
        final hold = repo.holdConversation = Completer<void>();
        final keepAlive = container.listen(
          conversationProvider(chat),
          (_, _) {},
        );
        addTearDown(keepAlive.close);
        final loading = container.read(conversationProvider(chat).future);
        await pumpEventQueue();
        repo.holdConversation = null;
        // ...then the community is locked, and told so, before it lands.
        repo.canPostOverride[chat] = false;
        realtime.emit(locked(community, 2));
        await pumpEventQueue();
        hold.complete();
        await loading;
        await pumpEventQueue();
        expect(current(chat).conversation.canPost, isFalse);
        expect(repo.conversationRequests, [chat, chat]);
      },
    );

    Future<Message> removeThenReadmit() async {
      realtime.onSubscribe = (_) =>
          const SubscriptionRefused(RealtimeErrorCode.conversationNotFound);
      repo.leftCommunities.add(community);
      realtime.emit(removed(community));
      await pumpEventQueue();
      expect(current(chat).removed, isTrue);
      // Added back, and the server admits the viewer again: something was
      // said meanwhile.
      repo.leftCommunities.remove(community);
      final said = await repo.sendText(
        chat,
        clientMessageId: 'c-after-rejoin',
        body: 'أهلًا بعودتك',
      );
      realtime.onSubscribe = (_) =>
          Subscribed(lastSequence: said.sequence, lastReadSequence: 0);
      return said;
    }

    test('opens again when the viewer is added back', () async {
      await load(chat);
      final said = await removeThenReadmit();
      realtime.emit(added(community));
      await pumpEventQueue();
      final state = await container.read(conversationProvider(chat).future);
      expect(state.removed, isFalse);
      expect(state.messages.map((m) => m.id), contains(said.id));
    });

    test('opens again on a reconnect the server admits', () async {
      await load(chat);
      final said = await removeThenReadmit();
      // The frame never arrived; the connection came back.
      realtime.setStatus(RealtimeStatus.reconnecting);
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      final state = await container.read(conversationProvider(chat).future);
      expect(state.removed, isFalse);
      expect(state.messages.map((m) => m.id), contains(said.id));
    });

    test('closes when the re-read says the chat is not the viewer’s', () async {
      await load(chat);
      repo.leftCommunities.add(community);
      realtime.emit(accessChanged(community));
      await pumpEventQueue();
      expect(current(chat).removed, isTrue);
    });

    test('ignores frames of other communities and of other people', () async {
      await load(chat);
      final before = repo.conversationRequests.length;
      realtime.subscriptions.clear();
      realtime.emit(locked(MockCommunityRepository.openId, 5));
      realtime.emit(removed(MockCommunityRepository.openId));
      realtime.emit(removed(community, userId: 'someone-else'));
      await pumpEventQueue();
      expect(repo.conversationRequests, hasLength(before));
      expect(realtime.subscriptions, isEmpty);
      expect(current(chat).removed, isFalse);
    });

    test('an ordinary conversation ignores community frames', () async {
      await load('mock-channel');
      final before = repo.conversationRequests.length;
      realtime.subscriptions.clear();
      realtime.emit(locked(community, 5));
      realtime.emit(removed(community));
      await pumpEventQueue();
      expect(repo.conversationRequests, hasLength(before));
      expect(realtime.subscriptions, isEmpty);
    });
  });

  group('the conversation list', () {
    Future<ConversationListState> load() {
      final keepAlive = container.listen(conversationListProvider, (_, _) {});
      addTearDown(keepAlive.close);
      return container.read(conversationListProvider.future);
    }

    List<String> ids() => container
        .read(conversationListProvider)
        .requireValue
        .items
        .map((c) => c.id)
        .toList();

    test('lists community chats with the rest', () async {
      await load();
      expect(ids(), contains(chat));
      expect(ids().take(3), ['mock-direct', 'mock-group', 'mock-channel']);
    });

    test('lets a community’s chat go when the viewer leaves it', () async {
      await load();
      repo.leftCommunities.add(community);
      realtime.emit(removed(community, reason: CommunityRemovalReason.left));
      // Gone at once...
      expect(ids(), isNot(contains(chat)));
      await pumpEventQueue();
      // ...and the server, asked again, agrees.
      expect(repo.listRequests, 2);
      expect(ids(), isNot(contains(chat)));
    });

    test('brings it back when the server overrules the frame', () async {
      await load();
      realtime.emit(removed(community));
      expect(ids(), isNot(contains(chat)));
      await pumpEventQueue();
      expect(ids(), contains(chat));
    });

    test('asks again when the viewer is added to a community', () async {
      repo.leftCommunities.add(community);
      await load();
      expect(ids(), isNot(contains(chat)));
      repo.leftCommunities.remove(community);
      realtime.emit(added(community));
      await pumpEventQueue();
      expect(repo.listRequests, 2);
      expect(ids(), contains(chat));
    });

    test(
      'never lets a next page asked for before a leave bring the chat back',
      () async {
        repo = ScriptedMessaging(conversationPageSize: 3);
        boot();
        await load();
        expect(ids(), ['mock-direct', 'mock-group', 'mock-channel']);
        // The next page takes its answer — with this community's chat...
        final hold = repo.holdList = Completer<void>();
        final more = container
            .read(conversationListProvider.notifier)
            .loadMore();
        await pumpEventQueue();
        repo.holdList = null;
        // ...then the viewer leaves the community before that answer lands.
        repo.leftCommunities.add(community);
        realtime.emit(removed(community, reason: CommunityRemovalReason.left));
        await pumpEventQueue();
        hold.complete();
        await more;
        await pumpEventQueue();
        expect(ids(), isNot(contains(chat)));
        final notifier = container.read(conversationListProvider.notifier);
        while (container.read(conversationListProvider).requireValue.hasMore) {
          await notifier.loadMore();
        }
        expect(ids(), isNot(contains(chat)));
        expect(ids(), contains(chatOf(MockCommunityRepository.openId)));
      },
    );

    test('ignores a community frame about someone else', () async {
      await load();
      realtime.emit(removed(community, userId: 'someone-else'));
      realtime.emit(added(community, userId: 'someone-else'));
      await pumpEventQueue();
      expect(repo.listRequests, 1);
      expect(ids(), contains(chat));
    });
  });

  test('says the community-chat refusals in words, not the generic line', () {
    const generic = 'تعذّر إتمام العملية. حاول مرة أخرى.';
    expect(MessagingCopy.error('something.new'), generic);
    for (final code in [
      'messaging.community_chat_over_capacity',
      'messaging.too_many_community_chat_lookups',
      'messaging.members_hidden',
      'messaging.membership_managed_by_community',
    ]) {
      expect(MessagingCopy.error(code), isNot(generic), reason: code);
    }
  });
}
