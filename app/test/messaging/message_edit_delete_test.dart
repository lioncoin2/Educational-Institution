import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';
import 'package:quran_institution_app/features/messaging/widgets/message_bubble.dart';
import 'package:quran_institution_app/features/notifications/notification_copy.dart';

Map<String, Object?> _wire({String? editedAt, String? deletedAt}) => {
  'id': 'm-1',
  'conversationId': 'c-1',
  'sequence': 4,
  'senderId': 'u-1',
  'type': 'TEXT',
  'body': deletedAt == null ? 'نص معدّل' : null,
  'replyToMessageId': null,
  'clientMessageId': null,
  'createdAt': '2026-10-25T08:00:00.000Z',
  'editedAt': editedAt,
  'deletedAt': deletedAt,
  'attachments': <Object?>[],
};

void main() {
  group('editing and deleting one’s own message (ADR 0045)', () {
    test('parses a message.edited frame, and drops one that disagrees', () {
      final frame = ServerFrame.parse(
        jsonEncode({
          'type': 'message.edited',
          'version': 1,
          'eventId': 'message.edited:m-1:2026-10-25T08:05:00.000Z',
          'occurredAt': '2026-10-25T08:05:00.000Z',
          'conversationId': 'c-1',
          'messageId': 'm-1',
          'sequence': 4,
          'message': _wire(editedAt: '2026-10-25T08:05:00.000Z'),
        }),
      );
      expect(frame, isA<MessageEditedEvent>());
      final edited = (frame! as MessageEditedEvent).message;
      expect(edited.body, 'نص معدّل');
      expect(edited.isEdited, isTrue);

      final mismatched = ServerFrame.parse(
        jsonEncode({
          'type': 'message.edited',
          'version': 1,
          'eventId': 'e',
          'occurredAt': '2026-10-25T08:05:00.000Z',
          'conversationId': 'c-2',
          'messageId': 'm-1',
          'sequence': 4,
          'message': _wire(editedAt: '2026-10-25T08:05:00.000Z'),
        }),
      );
      expect(mismatched, isNull);
    });

    test('a deleted message never reads as edited', () {
      final message = Message.fromJson(
        _wire(
          editedAt: '2026-10-25T08:05:00.000Z',
          deletedAt: '2026-10-25T08:06:00.000Z',
        ),
      );
      expect(message.isEdited, isFalse);
    });

    test(
      'the demo edits only the viewer’s own message, and deletes it anywhere',
      () async {
        final repo = MockMessagingRepository(latency: Duration.zero);
        final page = await repo.messages('mock-direct');
        final mine = page.items.firstWhere(
          (m) => m.senderId == MockMessagingRepository.viewer,
        );
        final theirs = page.items.firstWhere(
          (m) => m.senderId != MockMessagingRepository.viewer,
        );
        final edited = await repo.editMessage(
          'mock-direct',
          mine.id,
          body: 'نص جديد',
        );
        expect(edited.body, 'نص جديد');
        expect(edited.isEdited, isTrue);
        await expectLater(
          repo.editMessage('mock-direct', theirs.id, body: 'ليس لي'),
          throwsA(
            isA<MessagingException>().having(
              (e) => e.code,
              'code',
              'messaging.message_not_found',
            ),
          ),
        );
        // A direct conversation has no moderator — but the author deletes their own.
        await repo.deleteMessage('mock-direct', mine.id);
        await expectLater(
          repo.deleteMessage('mock-direct', theirs.id),
          throwsA(isA<MessagingException>()),
        );
        await expectLater(
          repo.editMessage('mock-direct', mine.id, body: 'بعد الحذف'),
          throwsA(
            isA<MessagingException>().having(
              (e) => e.code,
              'code',
              'messaging.message_deleted',
            ),
          ),
        );
      },
    );

    testWidgets(
      'the bubble offers edit and delete for one’s own, and shows «معدّلة»',
      (tester) async {
        var edits = 0;
        var deletes = 0;
        final message = Message.fromJson(
          _wire(editedAt: '2026-10-25T08:05:00.000Z'),
        );
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: MessageBubble(
                message: message,
                mine: true,
                onEdit: () => edits += 1,
                onDeleteOwn: () => deletes += 1,
              ),
            ),
          ),
        );
        expect(find.byKey(const Key('message-edited-m-1')), findsOneWidget);
        expect(find.textContaining(MessagingCopy.edited), findsOneWidget);
        await tester.longPress(find.text('نص معدّل'));
        await tester.pumpAndSettle();
        expect(find.text(MessagingCopy.edit), findsOneWidget);
        await tester.tap(find.byKey(const Key('message-edit-action')));
        await tester.pumpAndSettle();
        expect(edits, 1);
        await tester.longPress(find.text('نص معدّل'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('message-delete-own-action')));
        await tester.pumpAndSettle();
        expect(deletes, 1);
      },
    );

    testWidgets('someone else’s message offers neither', (tester) async {
      final message = Message.fromJson(_wire());
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: MessageBubble(message: message, mine: false)),
        ),
      );
      await tester.longPress(find.text('نص معدّل'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-edit-action')), findsNothing);
      expect(find.byKey(const Key('message-delete-own-action')), findsNothing);
    });

    test(
      'the conversation list preview follows an edit of the latest message',
      () {
        final conversation = Conversation.fromJson({
          'id': 'c-1',
          'type': 'GROUP',
          'title': 'حلقة الفجر',
          'counterpartUserId': null,
          'memberCount': 3,
          'myRole': 'MEMBER',
          'canPost': true,
          'canManageMembers': false,
          'lastSequence': 4,
          'lastReadSequence': 4,
          'unreadCount': 0,
          'lastMessage': {
            'sequence': 4,
            'senderId': 'u-1',
            'senderName': 'مريم',
            'type': 'TEXT',
            'text': 'نص قديم',
            'deleted': false,
            'createdAt': '2026-10-25T08:00:00.000Z',
          },
          'createdAt': '2026-10-25T07:00:00.000Z',
          'activityAt': '2026-10-25T08:00:00.000Z',
        });
        final edited = conversation.withEditedPreview(
          Message.fromJson(_wire(editedAt: '2026-10-25T08:05:00.000Z')),
        );
        expect(edited.lastMessage?.text, 'نص معدّل');
        expect(edited.unreadCount, conversation.unreadCount);
      },
    );
  });

  group('notification content (ADR 0046)', () {
    AppNotification received(Map<String, Object> params) =>
        AppNotification.fromJson({
          'id': 'n-1',
          'type': 'MESSAGE_RECEIVED',
          'category': 'MESSAGES',
          'titleKey': 'notification.message_received.title',
          'bodyKey': 'notification.message_received.body',
          'params': params,
          'target': {'kind': 'conversation', 'conversationId': 'c-1'},
          'createdAt': '2026-10-25T08:00:00.000Z',
          'readAt': null,
        });

    test('says who, where and what when the server includes them', () {
      expect(
        NotificationCopy.body(
          received({
            'senderDisplayName': 'الأستاذ عبدالله',
            'conversationTitle': 'حلقة الفجر',
            'messagePreview': 'واجب اليوم: سورة الملك',
            'messageType': 'TEXT',
            'conversationType': 'GROUP',
          }),
        ),
        'الأستاذ عبدالله في «حلقة الفجر»: واجب اليوم: سورة الملك',
      );
      expect(
        NotificationCopy.body(
          received({
            'senderDisplayName': 'الأستاذ عبدالله',
            'messagePreview': 'رقم الغرفة 4417',
            'conversationType': 'DIRECT',
          }),
        ),
        'الأستاذ عبدالله: رقم الغرفة 4417',
      );
    });

    test('says no more than it is given — never invents content', () {
      // Removed since, deleted, or a notification from before ADR 0046.
      expect(
        NotificationCopy.body(
          received({'senderDisplayName': 'الأستاذ عبدالله'}),
        ),
        'لديك رسالة جديدة من الأستاذ عبدالله.',
      );
      expect(NotificationCopy.body(received({})), 'لديك رسالة جديدة.');
    });
  });
}
