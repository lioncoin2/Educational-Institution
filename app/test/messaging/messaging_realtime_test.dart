import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_controller.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_list_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

const viewer = MockMessagingRepository.viewer;
const teacher = 'mock-teacher';

/// The mock server, with a record of every catch-up request and switches to
/// hold a send or a catch-up in flight.
class LiveRepository extends MockMessagingRepository {
  LiveRepository() : super(latency: Duration.zero);

  final List<int> afterRequests = [];
  int listRequests = 0;
  Completer<void>? holdSends;
  Completer<void>? holdCatchUp;
  Message? lastStored;

  @override
  Future<ConversationPage> conversations({String? cursor}) {
    listRequests += 1;
    return super.conversations(cursor: cursor);
  }

  @override
  Future<MessagePage> messages(
    String conversationId, {
    int? before,
    int? after,
    int limit = 30,
  }) async {
    if (after != null) {
      afterRequests.add(after);
      await holdCatchUp?.future;
    }
    return super.messages(
      conversationId,
      before: before,
      after: after,
      limit: limit,
    );
  }

  @override
  Future<Message> sendText(
    String conversationId, {
    required String clientMessageId,
    required String body,
  }) async {
    final stored = await super.sendText(
      conversationId,
      clientMessageId: clientMessageId,
      body: body,
    );
    lastStored = stored;
    await holdSends?.future;
    return stored;
  }
}

var _events = 0;

MessageSentEvent sent(Message message, {String? senderName}) =>
    MessageSentEvent(
      eventId: 'message.sent:${message.id}',
      occurredAt: message.createdAt,
      conversationId: message.conversationId,
      conversationType: ConversationType.group,
      message: message,
      senderName: senderName,
    );

MessageReadEvent read(String conversationId, int sequence) => MessageReadEvent(
  eventId: 'message.read:${_events++}',
  occurredAt: DateTime.now(),
  conversationId: conversationId,
  userId: viewer,
  lastReadSequence: sequence,
);

void main() {
  late LiveRepository repo;
  late FakeRealtimeClient realtime;
  late ProviderContainer container;

  setUp(() {
    repo = LiveRepository();
    realtime = FakeRealtimeClient();
    container = ProviderContainer(
      overrides: [
        messagingRepositoryProvider.overrideWithValue(repo),
        realtimeConnectionProvider.overrideWithValue(realtime),
      ],
    );
    addTearDown(container.dispose);
  });

  group('an open conversation, live', () {
    const id = 'mock-group';
    late ProviderSubscription<AsyncValue<ConversationState>> keepAlive;

    Future<ConversationState> open() async {
      keepAlive = container.listen(conversationProvider(id), (_, _) {});
      addTearDown(keepAlive.close);
      return container.read(conversationProvider(id).future);
    }

    ConversationState current() =>
        container.read(conversationProvider(id)).requireValue;

    Future<void> settle() => pumpEventQueue();

    test('appends a live message from someone else — once, however often it arrives', () async {
      await open();
      final message = repo.receive(id, senderId: teacher, body: 'درس اليوم');
      realtime.emit(sent(message, senderName: 'الأستاذ عبدالله'));
      realtime.emit(sent(message, senderName: 'الأستاذ عبدالله'));
      await settle();

      expect(current().messages.where((m) => m.id == message.id), hasLength(1));
      expect(current().messages.last.body, 'درس اليوم');
      expect(current().senderNames[teacher], 'الأستاذ عبدالله');
      expect(current().syncedThrough, 37);
      expect(repo.afterRequests, isEmpty); // contiguous: nothing to fetch
    });

    test('turns a pending message into its confirmed self exactly once, whichever confirmation lands first', () async {
      await open();
      repo.holdSends = Completer<void>();
      final sending = container
          .read(conversationProvider(id).notifier)
          .sendText('وصلت الرسالة؟');
      await settle();
      expect(current().pending, hasLength(1));

      // The live copy beats the HTTP response.
      realtime.emit(sent(repo.lastStored!));
      await settle();
      expect(current().pending, isEmpty);
      expect(
        current().messages.where((m) => m.body == 'وصلت الرسالة؟'),
        hasLength(1),
      );

      repo.holdSends!.complete();
      await sending;
      expect(
        current().messages.where((m) => m.body == 'وصلت الرسالة؟'),
        hasLength(1),
      );
      expect(current().pending, isEmpty);
    });

    test('does not accept N+1 as contiguous when N was lost: fills N over HTTP, in order', () async {
      await open(); // holds 1…36
      repo.holdCatchUp = Completer<void>();
      final n = repo.receive(id, senderId: teacher, body: 'N');
      final n1 = repo.receive(id, senderId: teacher, body: 'N+1');

      realtime.emit(sent(n1)); // N never arrives
      await settle();
      expect(current().messages.last.id, n1.id);
      expect(current().syncedThrough, 36); // 38 is held, but not as complete
      expect(current().hasGap, isTrue);
      expect(repo.afterRequests, [36]);

      repo.holdCatchUp!.complete();
      await settle();
      final sequences = current().messages.map((m) => m.sequence).toList();
      expect(sequences.where((s) => s >= 35), [35, 36, 37, 38]);
      expect(sequences, orderedEquals([...sequences]..sort()));
      expect(current().messages.firstWhere((m) => m.sequence == 37).id, n.id);
      expect(current().syncedThrough, 38);
      expect(current().hasGap, isFalse);

      // N arriving late changes nothing.
      realtime.emit(sent(n));
      await settle();
      expect(current().messages.where((m) => m.id == n.id), hasLength(1));
    });

    test('catches up, over HTTP, what was sent while disconnected', () async {
      await open();
      realtime.setStatus(RealtimeStatus.reconnecting);
      for (final body in ['one', 'two', 'three', 'four']) {
        repo.receive(id, senderId: teacher, body: body);
      }
      realtime.onSubscribe = (_) =>
          const Subscribed(lastSequence: 40, lastReadSequence: 36);
      realtime.setStatus(RealtimeStatus.reconnected);
      await settle();

      expect(realtime.subscriptions, contains(id));
      expect(repo.afterRequests, [36]);
      expect(
        current().messages.where((m) => m.sequence > 36).map((m) => m.body),
        ['one', 'two', 'three', 'four'],
      );
      expect(current().syncedThrough, 40);
    });

    test('asks nothing when the server says it is up to date', () async {
      realtime.onSubscribe = (_) =>
          const Subscribed(lastSequence: 36, lastReadSequence: 36);
      await open();
      await settle();
      expect(realtime.subscriptions, [id]);
      expect(repo.afterRequests, isEmpty);
    });

    test('moves the read mark only forward', () async {
      await open();
      final before = current().lastReadSequence;
      realtime.emit(read(id, before - 3)); // an old mark, arriving late
      await settle();
      expect(current().lastReadSequence, before);

      realtime.emit(read(id, 36));
      await settle();
      expect(current().lastReadSequence, 36);

      realtime.emit(read(id, 33));
      await settle();
      expect(current().lastReadSequence, 36);
    });

    test(
      'stops when the viewer is removed — and takes nothing more of it',
      () async {
        await open();
        realtime.emit(
          ParticipantRemovedEvent(
            eventId: 'participant.removed:x',
            occurredAt: DateTime.now(),
            conversationId: id,
            userId: viewer,
            reason: 'removed',
          ),
        );
        await settle();
        expect(current().removed, isTrue);

        final late = repo.receive(id, senderId: teacher, body: 'after');
        realtime.emit(sent(late));
        await container.read(conversationProvider(id).notifier).sendText('x');
        await settle();
        expect(current().messages.any((m) => m.id == late.id), isFalse);
        expect(current().pending, isEmpty);
      },
    );

    test('treats a refused subscription as the end of membership', () async {
      realtime.onSubscribe = (_) =>
          const SubscriptionRefused(RealtimeErrorCode.conversationNotFound);
      await open();
      await settle();
      expect(current().removed, isTrue);
    });

    test("ignores another conversation's events", () async {
      await open();
      final elsewhere = repo.receive(
        'mock-direct',
        senderId: teacher,
        body: 'elsewhere',
      );
      realtime.emit(sent(elsewhere));
      await settle();
      expect(current().messages.any((m) => m.id == elsewhere.id), isFalse);
    });
  });

  group('the conversation list, live', () {
    Future<ConversationListState> load() {
      final keepAlive = container.listen(conversationListProvider, (_, _) {});
      addTearDown(keepAlive.close);
      return container.read(conversationListProvider.future);
    }

    ConversationListState list() =>
        container.read(conversationListProvider).requireValue;

    Conversation item(String id) => list().items.firstWhere((c) => c.id == id);

    test('moves a conversation to the top with its new preview and one more unread', () async {
      await load();
      final before = item('mock-direct');
      final message = repo.receive(
        'mock-direct',
        senderId: teacher,
        body: 'هل راجعت الورد؟',
      );
      realtime.emit(sent(message, senderName: 'الأستاذ عبدالله'));
      await pumpEventQueue();

      expect(list().items.first.id, 'mock-direct');
      expect(item('mock-direct').lastMessage?.text, 'هل راجعت الورد؟');
      expect(item('mock-direct').lastMessage?.senderName, 'الأستاذ عبدالله');
      expect(item('mock-direct').unreadCount, before.unreadCount + 1);
      expect(item('mock-direct').lastSequence, message.sequence);
    });

    test(
      'counts nothing twice, and nothing of the viewer’s own as unread',
      () async {
        await load();
        final other = repo.receive('mock-direct', senderId: teacher, body: 'a');
        realtime.emit(sent(other));
        realtime.emit(sent(other));
        await pumpEventQueue();
        final afterOther = item('mock-direct').unreadCount;

        final own = await repo.sendText(
          'mock-direct',
          clientMessageId: 'from-my-laptop-1',
          body: 'من جهازي الآخر',
        );
        realtime.emit(sent(own));
        await pumpEventQueue();

        expect(afterOther, greaterThan(0));
        expect(item('mock-direct').unreadCount, 0); // writing reads up to here
        expect(item('mock-direct').lastReadSequence, own.sequence);
      },
    );

    test('clears a badge read on another device', () async {
      await load();
      final group = item('mock-group');
      expect(group.unreadCount, greaterThan(0));
      realtime.emit(read('mock-group', group.lastSequence));
      await pumpEventQueue();
      expect(item('mock-group').unreadCount, 0);
    });

    test('drops a conversation the viewer was removed from', () async {
      await load();
      realtime.emit(
        ParticipantRemovedEvent(
          eventId: 'participant.removed:y',
          occurredAt: DateTime.now(),
          conversationId: 'mock-group',
          userId: viewer,
          reason: 'removed',
        ),
      );
      await pumpEventQueue();
      expect(list().items.any((c) => c.id == 'mock-group'), isFalse);
    });

    test(
      'fetches the list again when added somewhere, or when back online',
      () async {
        await load();
        final requests = repo.listRequests;
        realtime.emit(
          ParticipantAddedEvent(
            eventId: 'participant.added:z',
            occurredAt: DateTime.now(),
            conversationId: 'somewhere-new',
            userId: viewer,
            role: ParticipantRole.member,
          ),
        );
        await pumpEventQueue();
        expect(repo.listRequests, requests + 1);

        realtime.setStatus(RealtimeStatus.reconnecting);
        realtime.setStatus(RealtimeStatus.reconnected);
        await pumpEventQueue();
        expect(repo.listRequests, requests + 2);
      },
    );

    test(
      'fetches the list again for a new conversation the viewer is in',
      () async {
        await load();
        final requests = repo.listRequests;
        realtime.emit(
          ConversationCreatedEvent(
            eventId: 'conversation.created:new',
            occurredAt: DateTime.now(),
            conversationId: 'brand-new',
            conversationType: ConversationType.direct,
          ),
        );
        await pumpEventQueue();
        expect(repo.listRequests, requests + 1);

        // One it already shows needs nothing.
        realtime.emit(
          ConversationCreatedEvent(
            eventId: 'conversation.created:mock-direct',
            occurredAt: DateTime.now(),
            conversationId: 'mock-direct',
            conversationType: ConversationType.direct,
          ),
        );
        await pumpEventQueue();
        expect(repo.listRequests, requests + 1);
      },
    );
  });
}
