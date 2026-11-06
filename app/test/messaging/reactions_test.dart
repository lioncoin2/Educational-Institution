import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/features/messaging/widgets/reaction_bar.dart';

/// Chat reactions (ADR 0053): the message model and realtime frame parse them,
/// and the reaction bar renders the counts and toggles on tap.
void main() {
  group('parsing', () {
    test('Message carries its reaction summary, empty when absent', () {
      final withReactions = Message.fromJson({
        'id': 'm1',
        'conversationId': 'c1',
        'sequence': 3,
        'senderId': 'u1',
        'type': 'TEXT',
        'body': 'hi',
        'createdAt': '2026-11-06T08:00:00.000Z',
        'attachments': <Object?>[],
        'reactions': [
          {'emoji': '👍', 'count': 2, 'mine': true},
          {'emoji': '❤️', 'count': 1, 'mine': false},
        ],
      });
      expect(withReactions.reactions, hasLength(2));
      expect(withReactions.reactions.first.emoji, '👍');
      expect(withReactions.reactions.first.mine, isTrue);

      final none = Message.fromJson({
        'id': 'm2',
        'conversationId': 'c1',
        'sequence': 4,
        'senderId': 'u1',
        'type': 'TEXT',
        'body': 'hi',
        'createdAt': '2026-11-06T08:00:00.000Z',
        'attachments': <Object?>[],
      });
      expect(none.reactions, isEmpty);
    });

    test('a message.reacted frame parses the counts', () {
      final frame = ServerFrame.parse(
        jsonEncode({
          'type': 'message.reacted',
          'eventId': 'message.reacted:m1:1',
          'occurredAt': '2026-11-06T08:00:00.000Z',
          'conversationId': 'c1',
          'messageId': 'm1',
          'counts': {'👍': 3, '😂': 1},
          'version': 1,
        }),
      );
      expect(frame, isA<MessageReactedEvent>());
      final reacted = frame as MessageReactedEvent;
      expect(reacted.messageId, 'm1');
      expect(reacted.counts, {'👍': 3, '😂': 1});
    });
  });

  group('ReactionBar', () {
    testWidgets('renders each emoji with its count and toggles on tap', (
      tester,
    ) async {
      String? toggled;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ReactionBar(
              reactions: const [
                MessageReaction(emoji: '👍', count: 2, mine: true),
                MessageReaction(emoji: '❤️', count: 1, mine: false),
              ],
              onReact: (emoji) => toggled = emoji,
            ),
          ),
        ),
      );
      expect(find.text('👍'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      expect(find.text('❤️'), findsOneWidget);
      await tester.tap(find.text('👍'));
      expect(toggled, '👍');
    });

    testWidgets('shows nothing when there are no reactions', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(body: ReactionBar(reactions: [])),
        ),
      );
      expect(find.byType(InkWell), findsNothing);
    });
  });
}
