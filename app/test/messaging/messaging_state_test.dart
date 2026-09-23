import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_controller.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_list_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The mock backend, with sends that can be made to fail and a record of
/// every clientMessageId the client used.
class FlakyMessagingRepository extends MockMessagingRepository {
  FlakyMessagingRepository() : super(latency: Duration.zero);

  int failNextSends = 0;
  final List<String> sentKeys = [];
  final List<int> readRequests = [];

  @override
  Future<Message> sendText(
    String conversationId, {
    required String clientMessageId,
    required String body,
  }) async {
    sentKeys.add(clientMessageId);
    if (failNextSends > 0) {
      failNextSends--;
      throw const MessagingException('network.unreachable', 'offline');
    }
    return super.sendText(
      conversationId,
      clientMessageId: clientMessageId,
      body: body,
    );
  }

  @override
  Future<int> markRead(String conversationId, int sequence) {
    readRequests.add(sequence);
    return super.markRead(conversationId, sequence);
  }
}

void main() {
  group('the mock backend keeps the server rules', () {
    final repo = MockMessagingRepository(latency: Duration.zero);

    test('pages by sequence, each message exactly once', () async {
      final seen = <int>[];
      var page = await repo.messages('mock-group', limit: 10);
      seen.insertAll(0, page.items.map((m) => m.sequence));
      while (page.hasOlder) {
        page = await repo.messages('mock-group', before: seen.first, limit: 10);
        seen.insertAll(0, page.items.map((m) => m.sequence));
      }
      expect(seen, List.generate(36, (i) => i + 1));
    });

    test(
      'stores a retried send once, and refuses a reused key for other content',
      () async {
        final a = await repo.sendText(
          'mock-direct',
          clientMessageId: 'retry-key-1',
          body: 'مرحبا',
        );
        final b = await repo.sendText(
          'mock-direct',
          clientMessageId: 'retry-key-1',
          body: 'مرحبا',
        );
        expect(b.id, a.id);
        await expectLater(
          repo.sendText(
            'mock-direct',
            clientMessageId: 'retry-key-1',
            body: 'غير',
          ),
          throwsA(isA<MessagingException>()),
        );
      },
    );

    test(
      'moves the watermark forward only, clamped to the last message',
      () async {
        final last = (await repo.conversation('mock-group')).lastSequence;
        expect(await repo.markRead('mock-group', 999), last);
        expect(await repo.markRead('mock-group', 1), last);
      },
    );

    test('refuses a reader posting in a channel', () async {
      await expectLater(
        repo.sendText(
          'mock-channel',
          clientMessageId: 'chan-key-01',
          body: 'x',
        ),
        throwsA(
          isA<MessagingException>().having(
            (e) => e.code,
            'code',
            'messaging.posting_not_allowed',
          ),
        ),
      );
    });
  });

  group('conversation state', () {
    late FlakyMessagingRepository repo;
    late ProviderContainer container;

    setUp(() {
      repo = FlakyMessagingRepository();
      container = ProviderContainer(
        overrides: [messagingRepositoryProvider.overrideWithValue(repo)],
      );
      // Keep the auto-disposed provider alive for the test.
      container.listen(conversationProvider('mock-group'), (_, _) {});
    });
    tearDown(() => container.dispose());

    Future<ConversationState> load() =>
        container.read(conversationProvider('mock-group').future);
    ConversationController controller() =>
        container.read(conversationProvider('mock-group').notifier);
    ConversationState current() =>
        container.read(conversationProvider('mock-group')).requireValue;

    test(
      'opens on the latest page, ascending, with older pages to load',
      () async {
        final state = await load();
        expect(state.messages.map((m) => m.sequence).last, 36);
        expect(state.messages.length, ConversationController.pageSize);
        expect(state.hasOlder, isTrue);
        expect(state.viewerId, MockMessagingRepository.viewer);
      },
    );

    test('merges older pages without gaps or duplicates', () async {
      await load();
      await controller().loadOlder();
      final sequences = current().messages.map((m) => m.sequence).toList();
      expect(sequences, List.generate(36, (i) => i + 1));
      expect(current().hasOlder, isFalse);
    });

    test(
      'shows a message at once, then replaces it with the stored one',
      () async {
        await load();
        final sending = controller().sendText('  السلام عليكم  ');
        expect(current().pending.single.body, 'السلام عليكم');
        expect(current().pending.single.status, DeliveryStatus.sending);
        await sending;
        expect(current().pending, isEmpty);
        expect(current().messages.last.body, 'السلام عليكم');
        expect(current().messages.last.sequence, 37);
      },
    );

    // The whole point of clientMessageId: a retry is the SAME message.
    test('a failed send can be retried, with the same client key', () async {
      await load();
      repo.failNextSends = 1;
      await controller().sendText('رسالة');
      final failed = current().pending.single;
      expect(failed.status, DeliveryStatus.failed);
      expect(failed.errorCode, 'network.unreachable');

      await controller().retry(failed.clientMessageId);
      expect(current().pending, isEmpty);
      expect(repo.sentKeys, [failed.clientMessageId, failed.clientMessageId]);
      expect(current().messages.where((m) => m.body == 'رسالة'), hasLength(1));
    });

    test('a failed send can be discarded', () async {
      await load();
      repo.failNextSends = 1;
      await controller().sendText('لن تُرسل');
      controller().discard(current().pending.single.clientMessageId);
      expect(current().pending, isEmpty);
    });

    test('ignores an empty message', () async {
      await load();
      await controller().sendText('   ');
      expect(current().pending, isEmpty);
      expect(repo.sentKeys, isEmpty);
    });

    test('marks the newest message read, and clears the list badge', () async {
      container.listen(conversationListProvider, (_, _) {});
      final list = await container.read(conversationListProvider.future);
      expect(
        list.items.firstWhere((c) => c.id == 'mock-group').unreadCount,
        greaterThan(0),
      );

      await load();
      await controller().markLatestRead();
      expect(repo.readRequests, [36]);
      expect(current().lastReadSequence, 36);
      final after = container.read(conversationListProvider).requireValue;
      expect(
        after.items.firstWhere((c) => c.id == 'mock-group').unreadCount,
        0,
      );

      await controller().markLatestRead(); // nothing new: no request
      expect(repo.readRequests, [36]);
    });

    test(
      'fills the gap when others wrote while this screen was open',
      () async {
        await load();
        // Someone else's messages arrive on the server meanwhile.
        await repo.sendText(
          'mock-group',
          clientMessageId: 'other-client-1',
          body: 'من جهاز آخر',
        );
        await controller().sendText('وهذه مني');
        final tail = current().messages
            .map((m) => m.body)
            .toList()
            .sublist(current().messages.length - 2);
        expect(tail, ['من جهاز آخر', 'وهذه مني']);
      },
    );

    test('sends a file as the message type its kind implies', () async {
      await load();
      await controller().sendFile(
        OutgoingFile(
          bytes: Uint8List(8),
          fileName: 'voice.m4a',
          contentType: 'audio/mp4',
          kind: AttachmentKind.voice,
          durationMs: 4000,
        ),
      );
      final last = current().messages.last;
      expect(last.type, MessageType.voice);
      expect(last.attachments.single.durationMs, 4000);
    });
  });

  group('conversation list state', () {
    test('surfaces a failure, then recovers on refresh', () async {
      var fail = true;
      final repo = _FailingList(() => fail);
      final container = ProviderContainer(
        overrides: [messagingRepositoryProvider.overrideWithValue(repo)],
      );
      addTearDown(container.dispose);
      container.listen(conversationListProvider, (_, _) {});
      await expectLater(
        container.read(conversationListProvider.future),
        throwsA(isA<MessagingException>()),
      );
      fail = false;
      await container.read(conversationListProvider.notifier).refresh();
      expect(
        container.read(conversationListProvider).requireValue.items,
        isNotEmpty,
      );
    });
  });
}

class _FailingList extends MockMessagingRepository {
  _FailingList(this.failing) : super(latency: Duration.zero);

  final bool Function() failing;

  @override
  Future<ConversationPage> conversations({String? cursor}) {
    if (failing()) {
      throw const MessagingException('network.unreachable', 'offline');
    }
    return super.conversations(cursor: cursor);
  }
}
