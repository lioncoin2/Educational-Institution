import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
// LiveSessionEndReason is the model enum now (the realtime parser converged
// onto it); the frame types still come from realtime_frames.
import 'package:quran_institution_app/data/models/live.dart';
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

  group('live frames', () {
    // The five live frames exactly as the backend builds them
    // (backend/test/fixtures/realtime-frames/live/). Each builder returns a
    // fresh map, so a test may mutate its own copy.
    Map<String, Object?> started() => {
      'type': 'live.session.started',
      'version': 1,
      'eventId': 'live.session.started:session-1',
      'occurredAt': '2026-09-24T10:00:00.000Z',
      'communityId': 'community-1',
      'sessionId': 'session-1',
    };
    Map<String, Object?> ended(String reason) => {
      'type': 'live.session.ended',
      'version': 1,
      'eventId': 'live.session.ended:session-1',
      'occurredAt': '2026-09-24T10:00:00.000Z',
      'communityId': 'community-1',
      'sessionId': 'session-1',
      'reason': reason,
    };
    Map<String, Object?> changed({Object? stateVersion = 7}) => {
      'type': 'live.session.changed',
      'version': 1,
      'eventId': 'live.session.changed:session-1:7',
      'occurredAt': '2026-09-24T10:00:00.000Z',
      'communityId': 'community-1',
      'sessionId': 'session-1',
      'stateVersion': stateVersion,
    };
    Map<String, Object?> removed() => {
      'type': 'live.participant.removed',
      'version': 1,
      'eventId': 'live.participant.removed:session-1:1790244000000',
      'occurredAt': '2026-09-24T10:00:00.000Z',
      'communityId': 'community-1',
      'sessionId': 'session-1',
    };
    Map<String, Object?> mediaReset() => {
      'type': 'live.session.media_reset',
      'version': 1,
      'eventId': 'live.session.media_reset:session-1:3',
      'occurredAt': '2026-09-24T10:00:00.000Z',
      'communityId': 'community-1',
      'sessionId': 'session-1',
    };

    test('reads each of the five live frames with its session identity', () {
      expect(
        parse(started()),
        isA<LiveSessionStartedEvent>()
            .having(
              (e) => e.eventId,
              'eventId',
              'live.session.started:session-1',
            )
            .having((e) => e.communityId, 'communityId', 'community-1')
            .having((e) => e.sessionId, 'sessionId', 'session-1'),
      );
      expect(
        parse(ended('moderator')),
        isA<LiveSessionEndedEvent>()
            .having((e) => e.reason, 'reason', LiveSessionEndReason.moderator)
            .having((e) => e.sessionId, 'sessionId', 'session-1'),
      );
      expect(
        parse(changed()),
        isA<LiveSessionChangedEvent>()
            .having((e) => e.stateVersion, 'stateVersion', 7)
            .having((e) => e.sessionId, 'sessionId', 'session-1'),
      );
      expect(
        parse(removed()),
        isA<LiveParticipantRemovedEvent>()
            .having((e) => e.communityId, 'communityId', 'community-1')
            .having((e) => e.sessionId, 'sessionId', 'session-1'),
      );
      expect(
        parse(mediaReset()),
        isA<LiveSessionMediaResetEvent>().having(
          (e) => e.sessionId,
          'sessionId',
          'session-1',
        ),
      );
    });

    test('every live frame is a LiveEvent carrying eventId and occurredAt', () {
      for (final json in [
        started(),
        ended('idle'),
        changed(),
        removed(),
        mediaReset(),
      ]) {
        final event = parse(json);
        expect(event, isA<LiveEvent>(), reason: json['type']! as String);
        final live = event! as LiveEvent;
        expect(live.eventId, isNotEmpty);
        expect(live.occurredAt, DateTime.parse('2026-09-24T10:00:00.000Z'));
      }
    });

    test('maps each end reason, and anything else to unknown', () {
      LiveSessionEndReason reasonOf(String wire) =>
          (parse(ended(wire))! as LiveSessionEndedEvent).reason;
      expect(reasonOf('moderator'), LiveSessionEndReason.moderator);
      expect(reasonOf('idle'), LiveSessionEndReason.idle);
      expect(
        reasonOf('community_closed'),
        LiveSessionEndReason.communityClosed,
      );
      expect(
        reasonOf('a_reason_a_newer_server_adds'),
        LiveSessionEndReason.unknown,
      );
    });

    test('participant.removed fabricates no participant id — session identity only', () {
      // The server sends this frame to the removed person alone, so the wire
      // carries no user id and the event exposes none. A stray id on the
      // wire is ignored, never surfaced.
      final event = parse(removed())! as LiveParticipantRemovedEvent;
      expect(event.communityId, 'community-1');
      expect(event.sessionId, 'session-1');
      expect(
        parse(removed()..['userId'] = 'u-1'),
        isA<LiveParticipantRemovedEvent>(),
      );
    });

    test('parses stateVersion exactly and never filters by it', () {
      // The parser carries the version; it does not compare or drop. A low
      // version parses identically to a high one — reconciliation is a later
      // slice's concern, not the parser's.
      int versionOf(Object? v) =>
          (parse(changed(stateVersion: v))! as LiveSessionChangedEvent)
              .stateVersion;
      expect(versionOf(7), 7);
      expect(versionOf(1), 1);
      expect(versionOf(999), 999);
    });

    test('drops malformed, wrong-version, missing, wrong-type, unknown', () {
      for (final text in [
        jsonEncode(started()..['version'] = 2), // wrong protocol version
        jsonEncode(started()..remove('sessionId')), // missing required field
        jsonEncode(started()..remove('eventId')), // missing eventId
        jsonEncode(changed(stateVersion: 'seven')), // wrong field type
        jsonEncode(ended('moderator')..remove('reason')), // missing reason
        jsonEncode(started()..['occurredAt'] = 'not-a-date'), // bad instant
        jsonEncode(started()..['type'] = 'live.session.paused'), // unknown type
      ]) {
        expect(ServerFrame.parse(text), isNull, reason: text);
      }
    });
  });

  test('still parses the existing non-live frames unchanged (regression)', () {
    expect(
      parse(messageSentJson(clientMessageId: 'k')),
      isA<MessageSentEvent>(),
    );
    expect(
      parse({
        'type': 'community.locked',
        'version': 1,
        'eventId': 'community.locked:community-1:2',
        'occurredAt': '2026-09-24T10:00:00.000Z',
        'communityId': 'community-1',
        'lifecycleVersion': 2,
      }),
      isA<CommunityLockedEvent>().having(
        (e) => e.lifecycleVersion,
        'lifecycleVersion',
        2,
      ),
    );
  });
}
