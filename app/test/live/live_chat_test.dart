import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_chat.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/state/live_chat_controller.dart';
import 'package:quran_institution_app/features/live/widgets/live_chat_panel.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

LiveChatMessage _message(String id, int position, {String body = 'نص'}) =>
    LiveChatMessage(
      id: id,
      sessionId: 's-1',
      senderId: 'u-$id',
      senderDisplayName: 'مريم',
      body: body,
      createdAt: DateTime.utc(2026, 10, 25, 8, position),
      position: position,
    );

/// A chat the test scripts: what each page says, and every call made.
class _FakeChat implements LiveChatRepository {
  LiveChatPage current = const LiveChatPage(
    items: [],
    nextCursor: null,
    locked: false,
    lockVersion: 0,
    canPost: true,
    canModerate: false,
  );
  LiveException? refusePost;
  int pageReads = 0;
  final List<String> posted = [];
  final List<bool> locks = [];

  @override
  Future<LiveChatPage> page(String sessionId, {String? before}) async {
    pageReads += 1;
    return current;
  }

  @override
  Future<LiveChatMessage> post(
    String sessionId, {
    required String clientMessageId,
    required String body,
  }) async {
    final refusal = refusePost;
    if (refusal != null) throw refusal;
    posted.add(body);
    return _message('posted-${posted.length}', 100 + posted.length, body: body);
  }

  @override
  Future<LiveChatLockState> setLocked(
    String sessionId, {
    required bool locked,
  }) async {
    locks.add(locked);
    return LiveChatLockState(locked: locked, lockVersion: locks.length);
  }
}

LiveSession _session() => LiveSession.fromJson({
  'id': 's-1',
  'communityId': 'c-1',
  'state': 'live',
  'stateVersion': 1,
  'hostUserId': 'host',
  'startedAt': '2026-10-25T08:00:00.000Z',
  'endedAt': null,
  'endReason': null,
  'participantCap': 300,
  'me': {'canModerate': false},
}, origin: DataOrigin.records);

void main() {
  late _FakeChat chat;
  late FakeRealtimeClient realtime;

  ProviderContainer container() {
    final c = ProviderContainer(
      overrides: [
        liveChatRepositoryProvider.overrideWithValue(chat),
        realtimeConnectionProvider.overrideWithValue(realtime),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  setUp(() {
    chat = _FakeChat();
    realtime = FakeRealtimeClient();
  });

  group('the controller (ADR 0047)', () {
    test('reads the page oldest-first and merges a live frame once', () async {
      chat.current = LiveChatPage(
        items: [_message('b', 2), _message('a', 1)],
        nextCursor: null,
        locked: false,
        lockVersion: 0,
        canPost: true,
        canModerate: false,
      );
      final c = container();
      final sub = c.listen(liveChatProvider('s-1'), (_, _) {});
      addTearDown(sub.close);
      final state = await c.read(liveChatProvider('s-1').future);
      expect(state.messages.map((m) => m.id), ['a', 'b']);

      final frame = LiveChatMessageEvent(
        eventId: 'live.chat.message:c',
        occurredAt: DateTime.utc(2026),
        communityId: 'c-1',
        sessionId: 's-1',
        message: _message('c', 3),
      );
      realtime.emit(frame);
      realtime.emit(frame); // a redelivery changes nothing
      // Another session's message never lands here.
      realtime.emit(
        LiveChatMessageEvent(
          eventId: 'live.chat.message:x',
          occurredAt: DateTime.utc(2026),
          communityId: 'c-2',
          sessionId: 's-2',
          message: LiveChatMessage(
            id: 'x',
            sessionId: 's-2',
            senderId: 'u',
            senderDisplayName: '',
            body: 'غريبة',
            createdAt: DateTime.utc(2026),
            position: 9,
          ),
        ),
      );
      expect(c.read(liveChatProvider('s-1')).value!.messages.map((m) => m.id), [
        'a',
        'b',
        'c',
      ]);
    });

    test('re-reads on a newer lock frame, and ignores an older one', () async {
      final c = container();
      final sub = c.listen(liveChatProvider('s-1'), (_, _) {});
      addTearDown(sub.close);
      await c.read(liveChatProvider('s-1').future);
      expect(chat.pageReads, 1);
      chat.current = const LiveChatPage(
        items: [],
        nextCursor: null,
        locked: true,
        lockVersion: 1,
        canPost: false,
        canModerate: false,
      );
      realtime.emit(
        LiveChatChangedEvent(
          eventId: 'live.chat.changed:s-1:1',
          occurredAt: DateTime.utc(2026),
          communityId: 'c-1',
          sessionId: 's-1',
          locked: true,
          lockVersion: 1,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      final state = c.read(liveChatProvider('s-1')).value!;
      expect(state.locked, isTrue);
      expect(state.canPost, isFalse);
      expect(state.closedToMe, isTrue);
      final reads = chat.pageReads;
      realtime.emit(
        LiveChatChangedEvent(
          eventId: 'live.chat.changed:s-1:1',
          occurredAt: DateTime.utc(2026),
          communityId: 'c-1',
          sessionId: 's-1',
          locked: true,
          lockVersion: 1,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(chat.pageReads, reads);
    });

    test('re-reads after a reconnect — nothing missed is trusted', () async {
      final c = container();
      final sub = c.listen(liveChatProvider('s-1'), (_, _) {});
      addTearDown(sub.close);
      await c.read(liveChatProvider('s-1').future);
      realtime.setStatus(RealtimeStatus.connected);
      await Future<void>.delayed(Duration.zero);
      expect(chat.pageReads, 2);
    });

    test(
      'a refused post propagates the server’s code and adds nothing',
      () async {
        chat.refusePost = const LiveException('live.chat_locked', 'locked');
        final c = container();
        final sub = c.listen(liveChatProvider('s-1'), (_, _) {});
        addTearDown(sub.close);
        await c.read(liveChatProvider('s-1').future);
        await expectLater(
          c.read(liveChatProvider('s-1').notifier).send('مرحبا'),
          throwsA(
            isA<LiveException>().having(
              (e) => e.code,
              'code',
              'live.chat_locked',
            ),
          ),
        );
        expect(c.read(liveChatProvider('s-1')).value!.messages, isEmpty);
      },
    );
  });

  group('the panel', () {
    Future<void> pump(WidgetTester tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            liveChatRepositoryProvider.overrideWithValue(chat),
            realtimeConnectionProvider.overrideWithValue(realtime),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                height: 600,
                child: LiveChatPanel(session: _session(), onOpenGroup: () {}),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets(
      'posts and shows the message; no lock switch for a participant',
      (tester) async {
        await pump(tester);
        expect(find.text(LiveCopy.chatEmpty), findsOneWidget);
        expect(find.byKey(const Key('live-chat-lock')), findsNothing);
        await tester.enterText(
          find.byKey(const Key('live-chat-field')),
          'سؤال',
        );
        await tester.tap(find.byKey(const Key('live-chat-send')));
        await tester.pumpAndSettle();
        expect(chat.posted, ['سؤال']);
        expect(find.text('سؤال'), findsOneWidget);
        // The group conversation stays a separate place.
        expect(find.text(LiveCopy.chatGroupOpen), findsOneWidget);
      },
    );

    testWidgets('closed to a participant: the notice, and no composer', (
      tester,
    ) async {
      chat.current = const LiveChatPage(
        items: [],
        nextCursor: null,
        locked: true,
        lockVersion: 1,
        canPost: false,
        canModerate: false,
      );
      await pump(tester);
      expect(find.byKey(const Key('live-chat-locked')), findsOneWidget);
      expect(find.text(LiveCopy.chatLockedForMe), findsOneWidget);
      expect(find.byKey(const Key('live-chat-field')), findsNothing);
    });

    testWidgets('a moderator closes it with the switch, and still writes', (
      tester,
    ) async {
      chat.current = const LiveChatPage(
        items: [],
        nextCursor: null,
        locked: false,
        lockVersion: 0,
        canPost: true,
        canModerate: true,
      );
      await pump(tester);
      expect(find.text(LiveCopy.chatLock), findsOneWidget);
      chat.current = const LiveChatPage(
        items: [],
        nextCursor: null,
        locked: true,
        lockVersion: 1,
        canPost: true,
        canModerate: true,
      );
      await tester.tap(find.byKey(const Key('live-chat-lock')));
      await tester.pumpAndSettle();
      expect(chat.locks, [true]);
      expect(find.text(LiveCopy.chatUnlock), findsOneWidget);
      expect(find.text(LiveCopy.chatLockedForModerator), findsOneWidget);
      expect(find.byKey(const Key('live-chat-field')), findsOneWidget);
    });
  });
}
