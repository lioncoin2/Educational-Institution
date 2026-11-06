import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_controller.dart';
import 'package:quran_institution_app/features/messaging/widgets/message_bubble.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

/// Read receipts, DIRECT only (ADR 0056): the model parses the counterpart's
/// read position, the controller seeds it and advances it from the other
/// person's live read marks, and the bubble shows ✓ (sent) / ✓✓ (seen).
void main() {
  group('model', () {
    Map<String, Object?> base() => {
      'id': 'c1',
      'type': 'DIRECT',
      'memberCount': 2,
      'myRole': 'MEMBER',
      'canPost': true,
      'canManageMembers': false,
      'lastSequence': 9,
      'lastReadSequence': 9,
      'unreadCount': 0,
      'createdAt': '2026-11-06T08:00:00.000Z',
      'activityAt': '2026-11-06T08:00:00.000Z',
    };

    test('parses counterpartReadSequence, null when absent', () {
      expect(
        Conversation.fromJson({...base(), 'counterpartReadSequence': 7})
            .counterpartReadSequence,
        7,
      );
      expect(Conversation.fromJson(base()).counterpartReadSequence, isNull);
    });
  });

  group('controller', () {
    late MockMessagingRepository repo;
    late FakeRealtimeClient realtime;
    late ProviderContainer container;

    setUp(() {
      repo = MockMessagingRepository(latency: Duration.zero);
      realtime = FakeRealtimeClient();
      container = ProviderContainer(
        overrides: [
          messagingRepositoryProvider.overrideWithValue(repo),
          realtimeConnectionProvider.overrideWithValue(realtime),
        ],
      );
      addTearDown(container.dispose);
    });

    Future<ConversationState> open(String id) {
      final keepAlive = container.listen(conversationProvider(id), (_, _) {});
      addTearDown(keepAlive.close);
      return container.read(conversationProvider(id).future);
    }

    ConversationState current(String id) =>
        container.read(conversationProvider(id)).requireValue;

    test('seeds the counterpart read position and derives ✓✓', () async {
      final state = await open('mock-direct');
      expect(state.counterpartReadSequence, 5);
      // The viewer's own line at sequence 4 is read (≤5); a later one is not.
      final mine = state.messages.firstWhere(
        (m) => state.isMine(m) && m.sequence <= 5,
      );
      expect(state.seenByCounterpart(mine), isTrue);
    });

    test('advances the counterpart watermark on a live read mark', () async {
      await open('mock-direct');
      realtime.emit(
        MessageReadEvent(
          eventId: 'message.read:mock-direct:mock-teacher:6',
          occurredAt: DateTime.now(),
          conversationId: 'mock-direct',
          userId: 'mock-teacher',
          lastReadSequence: 6,
        ),
      );
      await container.pump();
      expect(current('mock-direct').counterpartReadSequence, 6);
    });

    test('ignores an older counterpart mark (monotonic)', () async {
      await open('mock-direct');
      realtime.emit(
        MessageReadEvent(
          eventId: 'message.read:mock-direct:mock-teacher:2',
          occurredAt: DateTime.now(),
          conversationId: 'mock-direct',
          userId: 'mock-teacher',
          lastReadSequence: 2,
        ),
      );
      await container.pump();
      expect(current('mock-direct').counterpartReadSequence, 5);
    });

    test('a group conversation carries no receipts', () async {
      final state = await open('mock-group');
      final mine = state.messages.firstWhere(state.isMine);
      expect(state.seenByCounterpart(mine), isFalse);
    });
  });

  group('bubble', () {
    Widget host(Widget child) => MaterialApp(
      home: Scaffold(
        body: Directionality(textDirection: TextDirection.rtl, child: child),
      ),
    );

    Message mine() => Message(
      id: 'm1',
      conversationId: 'c1',
      sequence: 1,
      senderId: 'me',
      type: MessageType.text,
      body: 'رسالتي',
      createdAt: DateTime.utc(2026, 11, 6, 8),
    );

    testWidgets('✓✓ when seen', (tester) async {
      await tester.pumpWidget(
        host(MessageBubble(message: mine(), mine: true, seen: true)),
      );
      expect(find.byKey(const Key('message-seen')), findsOneWidget);
      expect(find.byKey(const Key('message-sent')), findsNothing);
    });

    testWidgets('✓ when sent but not seen', (tester) async {
      await tester.pumpWidget(
        host(MessageBubble(message: mine(), mine: true, seen: false)),
      );
      expect(find.byKey(const Key('message-sent')), findsOneWidget);
      expect(find.byKey(const Key('message-seen')), findsNothing);
    });

    testWidgets('no tick when receipts do not apply', (tester) async {
      await tester.pumpWidget(
        host(MessageBubble(message: mine(), mine: true)),
      );
      expect(find.byKey(const Key('message-sent')), findsNothing);
      expect(find.byKey(const Key('message-seen')), findsNothing);
    });
  });
}
