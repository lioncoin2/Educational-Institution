import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';

/// A `message.sent` frame exactly as the backend builds one.
Map<String, Object?> messageSentJson({
  String conversationId = 'c-1',
  int sequence = 7,
  String messageId = 'm-7',
  String? clientMessageId,
}) => {
  'type': 'message.sent',
  'version': 1,
  'eventId': 'message.sent:$messageId',
  'occurredAt': '2026-09-23T08:00:00.000Z',
  'conversationId': conversationId,
  'conversationType': 'GROUP',
  'messageId': messageId,
  'sequence': sequence,
  'message': {
    'id': messageId,
    'conversationId': conversationId,
    'sequence': sequence,
    'senderId': 'teacher-1',
    'type': 'TEXT',
    'body': 'السلام عليكم',
    'replyToMessageId': null,
    'clientMessageId': clientMessageId,
    'createdAt': '2026-09-23T08:00:00.000Z',
    'editedAt': null,
    'deletedAt': null,
    'attachments': <Object?>[],
  },
  'sender': {'userId': 'teacher-1', 'displayName': 'الأستاذ'},
};

ServerFrame? parse(Map<String, Object?> json) =>
    ServerFrame.parse(jsonEncode(json));

void main() {
  test(
    'reads a message.sent frame into the same Message the timeline uses',
    () {
      final frame = parse(messageSentJson(clientMessageId: 'key-1'));
      expect(frame, isA<MessageSentEvent>());
      final event = frame! as MessageSentEvent;
      expect(event.eventId, 'message.sent:m-7');
      expect(event.conversationId, 'c-1');
      expect(event.conversationType, ConversationType.group);
      expect(event.sequence, 7);
      expect(event.message.body, 'السلام عليكم');
      expect(event.message.clientMessageId, 'key-1');
      expect(event.senderName, 'الأستاذ');
    },
  );

  test('refuses a message.sent whose envelope and message disagree', () {
    final wrongSequence = messageSentJson()..['sequence'] = 8;
    final wrongConversation = messageSentJson()..['conversationId'] = 'c-2';
    expect(parse(wrongSequence), isNull);
    expect(parse(wrongConversation), isNull);
  });

  test('reads the control frames and the other events', () {
    expect(
      parse({
        'type': 'ready',
        'version': 1,
        'connectionId': 'conn-1',
        'userId': 'u-1',
        'expiresAt': '2026-09-23T08:15:00.000Z',
        'heartbeatSeconds': 25,
      }),
      isA<ReadyFrame>().having((f) => f.heartbeatSeconds, 'heartbeat', 25),
    );
    expect(
      parse({
        'type': 'subscribed',
        'version': 1,
        'conversationId': 'c-1',
        'lastSequence': 12,
        'lastReadSequence': 9,
        'id': 's1',
      }),
      isA<SubscribedFrame>().having((f) => f.lastSequence, 'last', 12),
    );
    expect(
      parse({
        'type': 'message.read',
        'version': 1,
        'eventId': 'e',
        'occurredAt': '2026-09-23T08:00:00.000Z',
        'conversationId': 'c-1',
        'userId': 'u-1',
        'lastReadSequence': 5,
      }),
      isA<MessageReadEvent>().having((f) => f.lastReadSequence, 'read', 5),
    );
    expect(
      parse({
        'type': 'conversation.created',
        'version': 1,
        'eventId': 'conversation.created:c-9',
        'occurredAt': '2026-09-23T08:00:00.000Z',
        'conversationId': 'c-9',
        'conversationType': 'DIRECT',
      }),
      isA<ConversationCreatedEvent>().having(
        (f) => f.conversationType,
        'type',
        ConversationType.direct,
      ),
    );
    expect(
      parse({
        'type': 'participant.removed',
        'version': 1,
        'eventId': 'e',
        'occurredAt': '2026-09-23T08:00:00.000Z',
        'conversationId': 'c-1',
        'userId': 'u-1',
        'reason': 'removed',
      }),
      isA<ParticipantRemovedEvent>(),
    );
  });

  test(
    'maps every error code the server documents, and anything else to unknown',
    () {
      for (final code in [
        'UNAUTHORIZED',
        'FORBIDDEN',
        'INVALID_EVENT',
        'INVALID_PAYLOAD',
        'CONVERSATION_NOT_FOUND',
        'NOT_MEMBER',
        'RATE_LIMITED',
        'SERVER_ERROR',
      ]) {
        final frame = parse({
          'type': 'error',
          'version': 1,
          'code': code,
          'message': 'x',
        });
        expect((frame! as ErrorFrame).code.wire, code);
      }
      final unknown = parse({
        'type': 'error',
        'version': 1,
        'code': 'TEAPOT',
        'message': 'x',
      });
      expect((unknown! as ErrorFrame).code, RealtimeErrorCode.unknown);
      expect(RealtimeErrorCode.notMember.meansNoAccess, isTrue);
      expect(RealtimeErrorCode.conversationNotFound.meansNoAccess, isTrue);
      expect(RealtimeErrorCode.serverError.meansNoAccess, isFalse);
    },
  );

  test('drops what this app must not act on — never half-applies it', () {
    for (final text in [
      'not json',
      '[1, 2]',
      '"message.sent"',
      jsonEncode({...messageSentJson(), 'version': 2}),
      jsonEncode({...messageSentJson(), 'type': 'message.edited'}),
      jsonEncode(messageSentJson()..remove('eventId')),
      jsonEncode(messageSentJson()..['sequence'] = 'seven'),
    ]) {
      expect(ServerFrame.parse(text), isNull, reason: text);
    }
  });
}
