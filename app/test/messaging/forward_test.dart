import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/widgets/message_bubble.dart';

/// Message forwarding (Phase 2): the model parses the origin, the mock copies a
/// message into another conversation keeping the original author, and the
/// bubble shows a "forwarded from" header plus a forward action.
void main() {
  group('model', () {
    test('parses forwardedFromSenderId, null when absent', () {
      final forwarded = Message.fromJson({
        'id': 'm1',
        'conversationId': 'c1',
        'sequence': 2,
        'senderId': 'u1',
        'type': 'TEXT',
        'body': 'hi',
        'createdAt': '2026-11-06T08:00:00.000Z',
        'attachments': <Object?>[],
        'forwardedFromSenderId': 'author-7',
      });
      expect(forwarded.forwardedFromSenderId, 'author-7');

      final plain = Message.fromJson({
        'id': 'm2',
        'conversationId': 'c1',
        'sequence': 3,
        'senderId': 'u1',
        'type': 'TEXT',
        'body': 'hi',
        'createdAt': '2026-11-06T08:00:00.000Z',
        'attachments': <Object?>[],
      });
      expect(plain.forwardedFromSenderId, isNull);
    });
  });

  group('mock repository', () {
    late MockMessagingRepository repo;

    setUp(() => repo = MockMessagingRepository(latency: Duration.zero));

    test('copies a message into another conversation, keeping the author', () async {
      final source = await repo.messages('mock-group');
      final original = source.items.firstWhere(
        (m) => m.senderId != MockMessagingRepository.viewer && !m.isDeleted,
      );

      final forwarded = await repo.forward(
        'mock-direct',
        clientMessageId: 'fwd-test-000001',
        sourceConversationId: 'mock-group',
        sourceMessageId: original.id,
      );

      expect(forwarded.conversationId, 'mock-direct');
      expect(forwarded.body, original.body);
      expect(forwarded.senderId, MockMessagingRepository.viewer);
      expect(forwarded.forwardedFromSenderId, original.senderId);

      // It is now the newest message of the target.
      final target = await repo.messages('mock-direct');
      expect(target.items.last.id, forwarded.id);
    });

    test('forwarding a forward keeps the first origin', () async {
      final source = await repo.messages('mock-group');
      final original = source.items.firstWhere(
        (m) => m.senderId != MockMessagingRepository.viewer && !m.isDeleted,
      );
      final once = await repo.forward(
        'mock-direct',
        clientMessageId: 'fwd-test-000002',
        sourceConversationId: 'mock-group',
        sourceMessageId: original.id,
      );
      final twice = await repo.forward(
        'mock-group',
        clientMessageId: 'fwd-test-000003',
        sourceConversationId: 'mock-direct',
        sourceMessageId: once.id,
      );
      expect(twice.forwardedFromSenderId, original.senderId);
    });

    test('a retry with the same clientMessageId returns the same message', () async {
      final source = await repo.messages('mock-group');
      final original = source.items.firstWhere(
        (m) => m.senderId != MockMessagingRepository.viewer,
      );
      final first = await repo.forward(
        'mock-direct',
        clientMessageId: 'fwd-test-000004',
        sourceConversationId: 'mock-group',
        sourceMessageId: original.id,
      );
      final retry = await repo.forward(
        'mock-direct',
        clientMessageId: 'fwd-test-000004',
        sourceConversationId: 'mock-group',
        sourceMessageId: original.id,
      );
      expect(retry.id, first.id);
    });
  });

  group('bubble', () {
    Message forwarded({String? from}) => Message(
      id: 'm1',
      conversationId: 'c1',
      sequence: 1,
      senderId: 'me',
      type: MessageType.text,
      body: 'نص محوّل',
      forwardedFromSenderId: from ?? 'author-1',
      createdAt: DateTime.utc(2026, 11, 6, 8),
    );

    Widget host(Widget child) => MaterialApp(
      home: Scaffold(
        body: Directionality(textDirection: TextDirection.rtl, child: child),
      ),
    );

    testWidgets('shows "forwarded from X" when the name is known', (tester) async {
      await tester.pumpWidget(
        host(
          MessageBubble(
            message: forwarded(),
            mine: true,
            forwardedFromName: 'سارة',
          ),
        ),
      );
      expect(find.byKey(const Key('message-forwarded-header')), findsOneWidget);
      expect(find.textContaining('سارة'), findsOneWidget);
    });

    testWidgets('an ordinary message shows no forwarded header', (tester) async {
      await tester.pumpWidget(
        host(
          MessageBubble(
            message: Message(
              id: 'm2',
              conversationId: 'c1',
              sequence: 2,
              senderId: 'me',
              type: MessageType.text,
              body: 'عادية',
              createdAt: DateTime.utc(2026, 11, 6, 8),
            ),
            mine: true,
          ),
        ),
      );
      expect(find.byKey(const Key('message-forwarded-header')), findsNothing);
    });

    testWidgets('offers a forward action on long-press', (tester) async {
      await tester.pumpWidget(
        host(
          MessageBubble(
            message: forwarded(),
            mine: true,
            forwardedFromName: 'سارة',
            onForward: () {},
          ),
        ),
      );
      await tester.longPress(find.text('نص محوّل'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-forward-action')), findsOneWidget);
    });
  });
}
