import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';

/// Deleted-message reply safety (audit P3-2).
///
/// Replying to a soft-deleted message is deliberately ALLOWED — keeping the
/// thread readable, and never letting a reply become a way to probe which
/// messages exist (backend `checkReply`, which finds a tombstone like any other
/// message). What must never happen is the DELETED CONTENT travelling to a
/// reader: the backend blanks a tombstone's body and attachments on every normal
/// read (`asSeen`), and the mock mirrors this by replacing the message in place
/// with [Message.asTombstone] at delete time. These tests lock in that the mock
/// stand-in keeps that guarantee, including for a target that originally carried
/// an attachment, so screens built against it behave as they would against the
/// real API.
void main() {
  // The viewer owns this community's chat, so it is theirs to post in and to
  // moderate — the one place the demo lets the viewer both reply and delete.
  const ownedChat = '${MockCommunityRepository.ownedId}-chat';

  late MockMessagingRepository repo;
  setUp(() => repo = MockMessagingRepository(latency: Duration.zero));

  OutgoingFile photo() => OutgoingFile(
    bytes: Uint8List(8),
    fileName: 'photo.png',
    contentType: 'image/png',
    kind: AttachmentKind.image,
  );

  Future<Message> targetInOwnedChat() async =>
      (await repo.messages(ownedChat)).items.first;

  group('the deleted target reads as a content-free tombstone', () {
    test('deleting a text message blanks its body in the timeline', () async {
      final target = await targetInOwnedChat();
      expect(target.body, isNotNull); // a real message before deletion

      await repo.deleteMessage(ownedChat, target.id);

      final seen = (await repo.messages(ownedChat)).items
          .firstWhere((m) => m.id == target.id);
      expect(seen.isDeleted, isTrue);
      expect(seen.body, isNull);
      expect(seen.attachments, isEmpty);
      // The one-line quote a reply would show is the neutral tombstone label,
      // never the original words.
      expect(MessagingCopy.quotePreview(seen), 'رسالة محذوفة');
    });

    test('deleting a media message drops its attachment reference', () async {
      final sent = await repo.sendImage(
        ownedChat,
        clientMessageId: 'media-to-be-deleted',
        image: photo(),
        caption: 'لا ينبغي أن تظهر',
      );
      expect(sent.attachments, isNotEmpty); // carried an attachment while live

      await repo.deleteMessage(ownedChat, sent.id);

      final seen = (await repo.messages(ownedChat)).items
          .firstWhere((m) => m.id == sent.id);
      expect(seen.isDeleted, isTrue);
      expect(seen.body, isNull); // the caption is gone
      expect(seen.attachments, isEmpty); // the file reference is gone
      expect(MessagingCopy.quotePreview(seen), 'رسالة محذوفة');
    });
  });

  group('replies to a deleted message are allowed and leak nothing', () {
    test(
      'a reply to a deleted text message keeps only the reference',
      () async {
        final target = await targetInOwnedChat();
        await repo.deleteMessage(ownedChat, target.id);

        final reply = await repo.sendText(
          ownedChat,
          clientMessageId: 'reply-to-deleted-text',
          body: 'ردّ على رسالة محذوفة',
          replyToMessageId: target.id,
        );
        expect(reply.replyToMessageId, target.id);

        // The target stays a content-free tombstone; the reply points at it.
        final items = (await repo.messages(ownedChat)).items;
        final tombstone = items.firstWhere((m) => m.id == target.id);
        expect(tombstone.isDeleted, isTrue);
        expect(tombstone.body, isNull);
        expect(
          items.firstWhere((m) => m.id == reply.id).replyToMessageId,
          target.id,
        );
      },
    );

    test(
      'a reply to a deleted MEDIA message is allowed; no file leaks',
      () async {
        final sent = await repo.sendImage(
          ownedChat,
          clientMessageId: 'media-reply-target',
          image: photo(),
          caption: 'سرّي',
        );
        final leakedAssetId = sent.attachments.first.fileAssetId;
        await repo.deleteMessage(ownedChat, sent.id);

        final reply = await repo.sendText(
          ownedChat,
          clientMessageId: 'reply-to-deleted-media',
          body: 'ردّ على صورة محذوفة',
          replyToMessageId: sent.id,
        );
        expect(reply.replyToMessageId, sent.id);

        final tombstone = (await repo.messages(ownedChat)).items
            .firstWhere((m) => m.id == sent.id);
        expect(tombstone.isDeleted, isTrue);
        expect(tombstone.attachments, isEmpty);
        // The quote a reply renders never names the deleted file or caption.
        final quote = MessagingCopy.quotePreview(tombstone);
        expect(quote, 'رسالة محذوفة');
        expect(quote, isNot(contains(leakedAssetId)));
        expect(quote, isNot(contains('سرّي')));
      },
    );

    test('an existing reply survives its target being deleted', () async {
      final target = await targetInOwnedChat();
      final reply = await repo.sendText(
        ownedChat,
        clientMessageId: 'reply-before-delete',
        body: 'جوابي الثابت',
        replyToMessageId: target.id,
      );

      // The target is moderated away after the reply already exists.
      await repo.deleteMessage(ownedChat, target.id);

      final items = (await repo.messages(ownedChat)).items;
      expect(items.firstWhere((m) => m.id == target.id).body, isNull);
      final seenReply = items.firstWhere((m) => m.id == reply.id);
      expect(seenReply.body, 'جوابي الثابت'); // the reply is untouched
      expect(seenReply.replyToMessageId, target.id); // relationship preserved
    });
  });
}
