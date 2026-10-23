import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';

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

  // ── Moderation (ADR 0029) ───────────────────────────────────────────────

  test('a message becomes a tombstone, keeping its identity and order', () {
    final live = Message.fromJson(message);
    expect(live.isDeleted, isFalse);
    expect(live.attachments, isNotEmpty);
    final gone = live.asTombstone(DateTime.utc(2026, 9, 2));
    expect(gone.isDeleted, isTrue);
    expect(gone.id, live.id);
    expect(gone.sequence, live.sequence);
    // The body and attachments are blanked, as the server blanks them.
    expect(gone.body, isNull);
    expect(gone.attachments, isEmpty);
  });

  test('ReviewedMessage parses the original, who deleted it, and the name', () {
    const reviewed = {
      'id': 'm-9',
      'conversationId': 'c-1',
      'sequence': 9,
      'senderId': 'u-2',
      'senderName': 'سارة',
      'type': 'TEXT',
      'body': 'النصّ الأصلي',
      'replyToMessageId': null,
      'createdAt': '2026-09-01T08:00:00.000Z',
      'editedAt': null,
      'deletedAt': '2026-09-02T08:00:00.000Z',
      'deletedBy': 'u-mod',
      'deletedByName': 'الأستاذ',
      'attachments': [],
    };
    final parsed = ReviewedMessage.fromJson(reviewed);
    expect(parsed.body, 'النصّ الأصلي');
    expect(parsed.deletedBy, 'u-mod');
    expect(parsed.deletedByName, 'الأستاذ');
    expect(parsed.senderName, 'سارة');
    expect(parsed.deletedAt, DateTime.utc(2026, 9, 2, 8));
  });

  test('MessagingException sorts moderation refusals by what they are', () {
    const forbidden = MessagingException(
      'messaging.message_moderation_forbidden',
      'x',
    );
    expect(forbidden.isModerationForbidden, isTrue);
    expect(forbidden.isReviewUnavailable, isFalse);

    const expired = MessagingException(
      'messaging.deleted_message_review_expired',
      'x',
    );
    expect(expired.isReviewUnavailable, isTrue);

    const absent = MessagingException(
      'messaging.deleted_message_not_found',
      'x',
    );
    expect(absent.isReviewUnavailable, isTrue);
  });

  test('withDeletedPreview blanks the preview text, keeping order', () {
    final parsed = Conversation.fromJson(conversation);
    expect(parsed.lastMessage?.deleted, isFalse);
    final after = parsed.withDeletedPreview();
    expect(after.lastMessage?.deleted, isTrue);
    expect(after.lastMessage?.text, isNull);
    // Only the preview changes — order, activity and sequence are the same.
    expect(after.lastMessage?.sequence, parsed.lastMessage?.sequence);
    expect(after.activityAt, parsed.activityAt);
    expect(after.lastSequence, parsed.lastSequence);
  });

  // The quote shown when a reply answers a message, for every media kind. Reads
  // only what the message carries — a document's real name, a voice duration —
  // and invents nothing.
  group('quotePreview for a reply target', () {
    Message msg(
      MessageType type, {
      String? body,
      List<Attachment> attachments = const [],
      bool deleted = false,
    }) => Message(
      id: 'm',
      conversationId: 'c',
      sequence: 1,
      senderId: 's',
      type: type,
      createdAt: DateTime(2026),
      body: body,
      attachments: attachments,
      deletedAt: deleted ? DateTime(2026) : null,
    );

    test('text quotes its body', () {
      expect(
        MessagingCopy.quotePreview(msg(MessageType.text, body: 'سلام')),
        'سلام',
      );
    });

    test('an image shows a truthful image label', () {
      expect(MessagingCopy.quotePreview(msg(MessageType.image)), 'صورة');
    });

    test('a document shows its real filename', () {
      final doc = msg(
        MessageType.file,
        attachments: const [
          Attachment(
            fileAssetId: 'f',
            available: true,
            kind: AttachmentKind.document,
            displayName: 'الخطة.pdf',
          ),
        ],
      );
      expect(MessagingCopy.quotePreview(doc), 'الخطة.pdf');
    });

    test('a document with no name falls back to a generic label', () {
      final doc = msg(
        MessageType.file,
        attachments: const [
          Attachment(
            fileAssetId: 'f',
            available: true,
            kind: AttachmentKind.document,
          ),
        ],
      );
      expect(MessagingCopy.quotePreview(doc), 'ملف');
    });

    test('a voice message shows its label and duration', () {
      final voice = msg(
        MessageType.voice,
        attachments: const [
          Attachment(
            fileAssetId: 'v',
            available: true,
            kind: AttachmentKind.voice,
            durationMs: 42000,
          ),
        ],
      );
      final preview = MessagingCopy.quotePreview(voice);
      expect(preview, startsWith('رسالة صوتية'));
      expect(preview, contains('·')); // the duration is appended
    });

    test('a deleted target is reported as deleted, never its content', () {
      expect(
        MessagingCopy.quotePreview(
          msg(MessageType.text, body: 'سر', deleted: true),
        ),
        'رسالة محذوفة',
      );
    });
  });

  // BUG-3: a community chat carries the community's product kind so the header
  // names a group a "group" even though its transport `type` is CHANNEL for
  // every community chat (Q51). A genuine channel, and a chat whose kind the
  // server did not report, are never mislabelled as a group.
  group('community chat kind in the header (BUG-3)', () {
    Conversation chat({
      required String type,
      String? communityId,
      Object? communityKind,
      int memberCount = 7,
    }) => Conversation.fromJson({
      'id': 'c-k',
      'type': type,
      'title': 'الحلقة',
      'memberCount': memberCount,
      'myRole': 'MEMBER',
      'canPost': false,
      'canManageMembers': false,
      'lastSequence': 0,
      'lastReadSequence': 0,
      'unreadCount': 0,
      'createdAt': '2026-01-01T00:00:00.000Z',
      'activityAt': '2026-01-01T00:00:00.000Z',
      'communityId': communityId,
      'communityKind': communityKind,
    });

    test('parses communityKind from the wire (GROUP/CHANNEL/unknown/absent)', () {
      expect(
        chat(type: 'CHANNEL', communityId: 'g', communityKind: 'GROUP').communityKind,
        CommunityKind.group,
      );
      expect(
        chat(type: 'CHANNEL', communityId: 'c', communityKind: 'CHANNEL').communityKind,
        CommunityKind.channel,
      );
      expect(
        chat(type: 'CHANNEL', communityId: 'u', communityKind: 'SOMETHING_NEW').communityKind,
        isNull,
      );
      expect(chat(type: 'CHANNEL', communityId: 'n').communityKind, isNull);
    });

    test('a community group chat is labelled a group, not a channel', () {
      final c = chat(type: 'CHANNEL', communityId: 'g', communityKind: 'GROUP');
      expect(MessagingCopy.conversationSubtitle(c), 'مجموعة · 7 عضوًا');
      expect(MessagingCopy.communityTypeLabel(CommunityKind.group, 7), 'مجموعة · 7 عضوًا');
    });

    test('a community channel chat stays a channel', () {
      final c = chat(type: 'CHANNEL', communityId: 'c', communityKind: 'CHANNEL');
      expect(MessagingCopy.conversationSubtitle(c), 'قناة · 7 مشتركًا');
      expect(MessagingCopy.communityTypeLabel(CommunityKind.channel, 7), 'قناة · 7 مشتركًا');
    });

    test('an unknown/missing kind on a community chat never mislabels it a group', () {
      // Falls back to the transport type label — which is "قناة" for the CHANNEL
      // transport, so a real channel is never shown as a group by accident.
      expect(
        MessagingCopy.conversationSubtitle(chat(type: 'CHANNEL', communityId: 'c')),
        'قناة · 7 مشتركًا',
      );
    });

    test('a non-community conversation is unchanged', () {
      expect(MessagingCopy.conversationSubtitle(chat(type: 'DIRECT')), 'محادثة خاصة');
      expect(
        MessagingCopy.conversationSubtitle(chat(type: 'GROUP', memberCount: 4)),
        'مجموعة · 4 أعضاء',
      );
    });

    test('communityKind survives a realtime update of the conversation', () {
      final c = chat(type: 'CHANNEL', communityId: 'g', communityKind: 'GROUP');
      expect(c.withReadUpTo(5).communityKind, CommunityKind.group);
    });
  });
}
