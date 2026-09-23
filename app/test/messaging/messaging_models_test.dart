import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/messaging.dart';

/// The shapes below are the backend's wire contract, verbatim
/// (backend/src/modules/messaging/api/responses.ts).
void main() {
  const conversation = {
    'id': 'c-1',
    'type': 'GROUP',
    'title': 'حلقة الفجر',
    'counterpartUserId': null,
    'memberCount': 4,
    'myRole': 'MEMBER',
    'canPost': true,
    'canManageMembers': false,
    'lastSequence': 12,
    'lastReadSequence': 9,
    'unreadCount': 3,
    'lastMessage': {
      'sequence': 12,
      'senderId': 'u-2',
      'senderName': 'أحمد',
      'type': 'VOICE',
      'text': null,
      'deleted': false,
      'createdAt': '2026-09-01T08:00:00.000Z',
    },
    'createdAt': '2026-08-30T08:00:00.000Z',
    'activityAt': '2026-09-01T08:00:00.000Z',
  };

  const message = {
    'id': 'm-1',
    'conversationId': 'c-1',
    'sequence': 3,
    'senderId': 'u-1',
    'type': 'IMAGE',
    'body': 'الواجب',
    'replyToMessageId': null,
    'clientMessageId': null,
    'createdAt': '2026-09-01T08:00:00.000Z',
    'editedAt': null,
    'deletedAt': null,
    'attachments': [
      {
        'fileAssetId': 'a-1',
        'available': true,
        'kind': 'IMAGE',
        'contentType': 'image/png',
        'byteSize': 256,
        'displayName': 'لوح.png',
        'durationMs': null,
        'width': 1200,
        'height': 800,
      },
    ],
  };

  test('Conversation parses exactly, and is real data', () {
    final parsed = Conversation.fromJson(conversation);
    expect(parsed.type, ConversationType.group);
    expect(parsed.myRole, ParticipantRole.member);
    expect(parsed.unreadCount, 3);
    expect(parsed.lastMessage?.type, MessageType.voice);
    expect(parsed.lastMessage?.senderName, 'أحمد');
    expect(parsed.origin, DataOrigin.profile);
  });

  test('Message parses its attachments', () {
    final parsed = Message.fromJson(message);
    expect(parsed.type, MessageType.image);
    expect(parsed.sequence, 3);
    expect(parsed.isDeleted, isFalse);
    expect(parsed.attachments.single.kind, AttachmentKind.image);
    expect(parsed.attachments.single.width, 1200);
  });

  test('a file the server no longer has parses with nulls', () {
    final gone = Attachment.fromJson({
      'fileAssetId': 'a-9',
      'available': false,
      'kind': null,
      'contentType': null,
      'byteSize': null,
      'displayName': null,
      'durationMs': null,
      'width': null,
      'height': null,
    });
    expect(gone.available, isFalse);
    expect(gone.kind, AttachmentKind.unknown);
  });

  test('MessagePage parses senders into a name map', () {
    final page = MessagePage.fromJson({
      'items': [message],
      'hasOlder': true,
      'hasNewer': false,
      'lastReadSequence': 2,
      'senders': [
        {'userId': 'u-1', 'displayName': 'الأستاذ'},
      ],
    });
    expect(page.senderNames, {'u-1': 'الأستاذ'});
    expect(page.hasOlder, isTrue);
  });

  test('values a newer server adds degrade to unknown instead of crashing', () {
    expect(MessageType.fromWire('VIDEO'), MessageType.unknown);
    expect(ConversationType.fromWire('BROADCAST'), ConversationType.unknown);
    expect(ParticipantRole.fromWire('MODERATOR'), ParticipantRole.unknown);
  });

  test('reading clears the badge only when everything is read', () {
    final parsed = Conversation.fromJson(conversation);
    expect(parsed.withReadUpTo(10).unreadCount, 3);
    expect(parsed.withReadUpTo(12).unreadCount, 0);
    expect(parsed.withReadUpTo(4).lastReadSequence, 9); // never backwards
  });
}
