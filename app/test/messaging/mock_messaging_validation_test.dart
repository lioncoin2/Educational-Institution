import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';

/// The mock messaging repository must keep the real backend's send-validation
/// and idempotency rules (audit P3-1), so screens and tests built against it
/// behave as they would against the API:
///  - the clientMessageId shape (backend `CLIENT_MESSAGE_ID_SHAPE`),
///  - reply-target scoping (backend `checkReply`),
///  - duplicate identity (backend `sameContent`).
void main() {
  const directChat = 'mock-direct'; // a chat the viewer may post in
  const groupChat = 'mock-group'; // another conversation
  const ownedChat =
      '${MockCommunityRepository.ownedId}-chat'; // a community chat

  late MockMessagingRepository repo;
  setUp(() => repo = MockMessagingRepository(latency: Duration.zero));

  Matcher throwsCode(String code) =>
      throwsA(isA<MessagingException>().having((e) => e.code, 'code', code));

  OutgoingFile photo() => OutgoingFile(
    bytes: Uint8List(8),
    fileName: 'photo.png',
    contentType: 'image/png',
    kind: AttachmentKind.image,
  );

  group('clientMessageId shape', () {
    test(
      'accepts the minimum length (8) and the maximum length (64)',
      () async {
        final min = await repo.sendText(
          directChat,
          clientMessageId: 'a' * 8,
          body: 'x',
        );
        expect(min.clientMessageId, 'a' * 8);
        final max = await repo.sendText(
          directChat,
          clientMessageId: 'b' * 64,
          body: 'y',
        );
        expect(max.clientMessageId, 'b' * 64);
      },
    );

    test('accepts letters, digits, "-" and "_"', () async {
      final sent = await repo.sendText(
        directChat,
        clientMessageId: 'Ab9_-Cd012',
        body: 'x',
      );
      expect(sent.clientMessageId, 'Ab9_-Cd012');
    });

    test(
      'rejects too short (7), too long (65) and disallowed characters',
      () async {
        for (final bad in ['a' * 7, 'a' * 65, 'has space', 'bad!chars', '']) {
          await expectLater(
            repo.sendText(directChat, clientMessageId: bad, body: 'x'),
            throwsCode('messaging.client_message_id_invalid'),
          );
        }
      },
    );

    test('is checked before the conversation and posting rules', () async {
      // The server validates the draft (the key included) before the access
      // check, so an unusable key to an unknown chat fails on the key first.
      await expectLater(
        repo.sendText(
          'no-such-conversation',
          clientMessageId: 'short',
          body: 'x',
        ),
        throwsCode('messaging.client_message_id_invalid'),
      );
    });
  });

  group('reply-target validation', () {
    test('accepts a target in the same conversation', () async {
      final target = (await repo.messages(directChat)).items.first;
      final sent = await repo.sendText(
        directChat,
        clientMessageId: 'reply-ok-1',
        body: 'ردّ',
        replyToMessageId: target.id,
      );
      expect(sent.replyToMessageId, target.id);
    });

    test('refuses a target from another conversation (no leak)', () async {
      final elsewhere = (await repo.messages(groupChat)).items.first;
      await expectLater(
        repo.sendText(
          directChat,
          clientMessageId: 'reply-x-1',
          body: 'x',
          replyToMessageId: elsewhere.id,
        ),
        throwsCode('messaging.reply_target_not_found'),
      );
    });

    test('refuses an unknown target id', () async {
      await expectLater(
        repo.sendText(
          directChat,
          clientMessageId: 'reply-x-2',
          body: 'x',
          replyToMessageId: 'does-not-exist',
        ),
        throwsCode('messaging.reply_target_not_found'),
      );
    });

    test('still allows replying to a deleted (tombstoned) message', () async {
      // The audit flagged reply-to-deleted as a separate policy question that is
      // explicitly OUT of scope here; this test pins the CURRENT behavior so the
      // alignment does not change it. A deleted message is still "found".
      final target = (await repo.messages(ownedChat)).items.first;
      await repo.deleteMessage(
        ownedChat,
        target.id,
      ); // community-chat moderation
      final sent = await repo.sendText(
        ownedChat,
        clientMessageId: 'reply-del-1',
        body: 'ردّ على رسالة محذوفة',
        replyToMessageId: target.id,
      );
      expect(sent.replyToMessageId, target.id);
    });
  });

  group('duplicate identity', () {
    test(
      'an exact retry of the same key returns the one stored message',
      () async {
        final before = (await repo.messages(directChat)).items.length;
        final first = await repo.sendText(
          directChat,
          clientMessageId: 'dup-key-1',
          body: 'مرحبا',
        );
        final retry = await repo.sendText(
          directChat,
          clientMessageId: 'dup-key-1',
          body: 'مرحبا',
        );
        expect(retry.id, first.id);
        expect((await repo.messages(directChat)).items.length, before + 1);
      },
    );

    test('the same key with a different body is a conflict', () async {
      await repo.sendText(directChat, clientMessageId: 'dup-key-2', body: 'أ');
      await expectLater(
        repo.sendText(directChat, clientMessageId: 'dup-key-2', body: 'ب'),
        throwsCode('messaging.client_message_id_reused'),
      );
    });

    test(
      'the same key and body but a DIFFERENT reply target is a conflict',
      () async {
        final msgs = (await repo.messages(directChat)).items;
        await repo.sendText(
          directChat,
          clientMessageId: 'dup-key-3',
          body: 'نفس',
          replyToMessageId: msgs[0].id,
        );
        await expectLater(
          repo.sendText(
            directChat,
            clientMessageId: 'dup-key-3',
            body: 'نفس',
            replyToMessageId: msgs[1].id,
          ),
          throwsCode('messaging.client_message_id_reused'),
        );
      },
    );

    test(
      'the same key and body, one a reply and one not, is a conflict',
      () async {
        final target = (await repo.messages(directChat)).items.first.id;
        await repo.sendText(
          directChat,
          clientMessageId: 'dup-key-4',
          body: 'نفس',
        );
        await expectLater(
          repo.sendText(
            directChat,
            clientMessageId: 'dup-key-4',
            body: 'نفس',
            replyToMessageId: target,
          ),
          throwsCode('messaging.client_message_id_reused'),
        );
      },
    );

    test('an exact media retry returns the one stored message', () async {
      final first = await repo.sendImage(
        directChat,
        clientMessageId: 'dup-img-1',
        image: photo(),
      );
      final retry = await repo.sendImage(
        directChat,
        clientMessageId: 'dup-img-1',
        image: photo(),
      );
      expect(retry.id, first.id);
    });

    test(
      'reusing a key across message types (image then text) is a conflict',
      () async {
        await repo.sendImage(
          directChat,
          clientMessageId: 'dup-mix-1',
          image: photo(),
        );
        await expectLater(
          repo.sendText(directChat, clientMessageId: 'dup-mix-1', body: 'x'),
          throwsCode('messaging.client_message_id_reused'),
        );
      },
    );

    test('the same image key with a different caption is a conflict', () async {
      await repo.sendImage(
        directChat,
        clientMessageId: 'dup-cap-1',
        image: photo(),
        caption: 'أ',
      );
      await expectLater(
        repo.sendImage(
          directChat,
          clientMessageId: 'dup-cap-1',
          image: photo(),
          caption: 'ب',
        ),
        throwsCode('messaging.client_message_id_reused'),
      );
    });
  });
}
