import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/widgets/foundations/app_avatar.dart';
import 'package:quran_institution_app/data/media/media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_live_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/community_screen.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';
import 'package:quran_institution_app/features/messaging/widgets/message_bubble.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

/// The mock backend with switches for the states a screen must survive.
class ScriptedRepository extends MockMessagingRepository {
  ScriptedRepository() : super(latency: Duration.zero);

  bool failList = false;
  int failSends = 0;
  List<Conversation>? extraPage;
  int? unreadOverride;

  @override
  Future<ConversationPage> conversations({String? cursor}) async {
    if (failList) {
      throw const MessagingException('network.unreachable', 'offline');
    }
    if (cursor == 'page-2') {
      return ConversationPage(items: extraPage ?? const []);
    }
    final page = await super.conversations();
    final items = unreadOverride == null
        ? page.items
        : [for (final c in page.items) _withUnread(c, unreadOverride!)];
    return ConversationPage(
      items: items,
      nextCursor: extraPage == null ? null : 'page-2',
    );
  }

  @override
  Future<Message> sendText(
    String conversationId, {
    required String clientMessageId,
    required String body,
    String? replyToMessageId,
  }) async {
    if (failSends > 0) {
      failSends--;
      throw const MessagingException('network.unreachable', 'offline');
    }
    return super.sendText(
      conversationId,
      clientMessageId: clientMessageId,
      body: body,
      replyToMessageId: replyToMessageId,
    );
  }
}

Conversation _withUnread(Conversation c, int unread) => Conversation(
  id: c.id,
  type: c.type,
  title: c.title,
  counterpartUserId: c.counterpartUserId,
  memberCount: c.memberCount,
  myRole: c.myRole,
  canPost: c.canPost,
  canManageMembers: c.canManageMembers,
  lastSequence: c.lastSequence,
  lastReadSequence: c.lastReadSequence,
  unreadCount: unread,
  lastMessage: c.lastMessage,
  createdAt: c.createdAt,
  activityAt: c.activityAt,
  origin: DataOrigin.mock,
);

class FakePicker implements AttachmentPicker {
  @override
  bool get isAvailable => true;

  @override
  Future<OutgoingFile?> pickImage() async => OutgoingFile(
    bytes: Uint8List(64),
    fileName: 'board.png',
    contentType: 'image/png',
    kind: AttachmentKind.image,
    width: 400,
    height: 300,
  );

  @override
  Future<OutgoingFile?> pickDocument() async => null;
}

/// A live backend the test drives: [current] is the session `currentSession`
/// returns (null = none), so a session can be made to appear and disappear.
/// `getSession` (used by the controller when an `ended` hint arrives) returns
/// the held session or, once cleared, an ended view of it. Every other method
/// is unused by the indicator and throws if reached.
class _FakeLive implements LiveRepository {
  _FakeLive(this.communityId);

  final String communityId;
  LiveSession? current;

  @override
  Future<LiveSession?> currentSession(String communityId) async => current;

  @override
  Future<LiveSession> getSession(String sessionId) async =>
      current ??
      LiveSession(
        id: sessionId,
        communityId: communityId,
        state: LiveSessionState.ended,
        hostUserId: 'u-host',
        startedAt: DateTime.utc(2026),
        endedAt: DateTime.utc(2026, 1, 1, 1),
        endReason: LiveSessionEndReason.moderator,
        speakerCount: 0,
        me: const LiveMe(),
      );

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

LiveSession _liveSession(String communityId) => LiveSession(
  id: 'live-$communityId',
  communityId: communityId,
  state: LiveSessionState.live,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 1,
  me: const LiveMe(),
);

void main() {
  late ScriptedRepository repo;
  late ProviderContainer container;

  Future<void> open(
    WidgetTester tester,
    String location, {
    List<Override> extra = const [],
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    container = ProviderContainer(
      overrides: [
        messagingRepositoryProvider.overrideWithValue(repo),
        ...extra,
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const QuranInstitutionApp(),
      ),
    );
    await tester.pump(const Duration(seconds: 3)); // the splash timer
    await tester.pumpAndSettle();
    container.read(routerProvider).go(location);
    await tester.pumpAndSettle();
  }

  setUp(() => repo = ScriptedRepository());

  testWidgets(
    'lists direct conversations with previews and unread badges, flagged as demo data',
    (tester) async {
      await open(tester, '/messages');
      // Messages is direct-only: the direct conversation shows; community
      // group/channel chats do not (they live in Communities).
      expect(find.text('الأستاذ عبدالله'), findsOneWidget);
      expect(find.text('حلقة الفجر — التلاوة'), findsNothing);
      expect(find.text('إعلانات المعهد'), findsNothing);
      expect(find.textContaining('محادثات تجريبية'), findsOneWidget);
      // mock-direct: six messages, read to four, two unread from the teacher.
      expect(find.text('2'), findsOneWidget);
    },
  );

  testWidgets('caps the unread badge at 99+', (tester) async {
    repo.unreadOverride = 100;
    await open(tester, '/messages');
    // One 99+ badge per listed (direct-only) conversation.
    final listed = (await repo.conversations()).items.length;
    expect(listed, greaterThan(0));
    expect(find.text('99+'), findsNWidgets(listed));
  });

  testWidgets('opens a conversation, shows its messages, and marks it read', (
    tester,
  ) async {
    await open(tester, '/messages');
    await tester.tap(find.text('الأستاذ عبدالله'));
    await tester.pumpAndSettle();

    expect(find.textContaining('لا تنسَ تسجيل التلاوة'), findsOneWidget);
    expect(find.text('رسائل جديدة'), findsOneWidget);
    expect((await repo.conversation('mock-direct')).lastReadSequence, 6);
  });

  testWidgets('sends a message and shows it in the timeline', (tester) async {
    await open(tester, '/messages/mock-direct');
    await tester.enterText(find.byType(TextField), 'جزاك الله خيرًا');
    await tester.pump();
    await tester.tap(find.byTooltip('إرسال'));
    await tester.pumpAndSettle();

    expect(find.text('جزاك الله خيرًا'), findsOneWidget);
    final messages = await repo.messages('mock-direct');
    expect(messages.items.last.body, 'جزاك الله خيرًا');
  });

  testWidgets(
    'keeps a failed message with retry, and retrying delivers it once',
    (tester) async {
      repo.failSends = 1;
      await open(tester, '/messages/mock-direct');
      await tester.enterText(find.byType(TextField), 'رسالة معلّقة');
      await tester.pump();
      await tester.tap(find.byTooltip('إرسال'));
      await tester.pumpAndSettle();

      expect(find.text('إعادة الإرسال'), findsOneWidget);
      expect(find.textContaining('تعذّر الاتصال بالخادم'), findsOneWidget);

      await tester.tap(find.text('إعادة الإرسال'));
      await tester.pumpAndSettle();
      expect(find.text('إعادة الإرسال'), findsNothing);
      final bodies = (await repo.messages('mock-direct')).items
          .map((m) => m.body);
      expect(bodies.where((b) => b == 'رسالة معلّقة'), hasLength(1));
    },
  );

  testWidgets('shows a channel read-only to its readers', (tester) async {
    await open(tester, '/messages/mock-channel');
    expect(find.textContaining('يمكنك القراءة فقط'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('offers attachments and voice only when this build can', (
    tester,
  ) async {
    await open(tester, '/messages/mock-direct');
    final attach = tester.widget<IconButton>(
      find.ancestor(
        of: find.byIcon(Icons.attach_file_rounded),
        matching: find.byType(IconButton),
      ),
    );
    final mic = tester.widget<IconButton>(
      find.ancestor(
        of: find.byIcon(Icons.mic_none_rounded),
        matching: find.byType(IconButton),
      ),
    );
    expect(attach.onPressed, isNull);
    expect(attach.tooltip, 'إرفاق الملفات غير متاح في هذا الإصدار');
    expect(mic.onPressed, isNull);
    expect(mic.tooltip, 'التسجيل الصوتي غير متاح في هذا الإصدار');
  });

  testWidgets('sends a picked image through the attachment seam', (
    tester,
  ) async {
    await open(
      tester,
      '/messages/mock-direct',
      extra: [attachmentPickerProvider.overrideWithValue(FakePicker())],
    );
    await tester.tap(find.byTooltip('إرفاق ملف'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('صورة'));
    await tester.pumpAndSettle();

    final last = (await repo.messages('mock-direct')).items.last;
    expect(last.type, MessageType.image);
    expect(last.attachments.single.displayName, 'board.png');
    // The demo stores no bytes: the bubble shows a placeholder, not an error.
    expect(tester.takeException(), isNull);
  });

  testWidgets('shows an error with retry, and recovers', (tester) async {
    repo.failList = true;
    await open(tester, '/messages');
    expect(find.text('تعذّر عرض المحتوى'), findsOneWidget);

    repo.failList = false;
    await tester.tap(find.text('إعادة المحاولة'));
    await tester.pumpAndSettle();
    expect(find.text('الأستاذ عبدالله'), findsOneWidget);
  });

  testWidgets('loads the next page of conversations on request', (
    tester,
  ) async {
    final seed = await MockMessagingRepository(latency: Duration.zero)
        .conversation('mock-direct');
    repo.extraPage = [
      Conversation(
        id: 'page-two',
        type: ConversationType.direct,
        title: 'أستاذة مريم',
        counterpartUserId: 'mock-teacher-2',
        memberCount: 2,
        myRole: ParticipantRole.member,
        canPost: true,
        canManageMembers: false,
        lastSequence: 0,
        lastReadSequence: 0,
        unreadCount: 0,
        createdAt: seed.createdAt,
        activityAt: seed.createdAt,
      ),
    ];
    await open(tester, '/messages');
    expect(find.text('أستاذة مريم'), findsNothing);
    await tester.scrollUntilVisible(find.text('عرض المزيد'), 200);
    await tester.tap(find.text('عرض المزيد'));
    await tester.pumpAndSettle();
    expect(find.text('أستاذة مريم'), findsOneWidget);
  });

  group('live', () {
    late FakeRealtimeClient realtime;
    setUp(() => realtime = FakeRealtimeClient());

    List<Override> live() => [
      realtimeConnectionProvider.overrideWithValue(realtime),
    ];

    testWidgets('shows a message the moment it arrives', (tester) async {
      await open(tester, '/messages/mock-direct', extra: live());
      final message = repo.receive(
        'mock-direct',
        senderId: 'mock-teacher',
        body: 'رسالة وصلت الآن',
      );
      realtime.emit(
        MessageSentEvent(
          eventId: 'message.sent:${message.id}',
          occurredAt: message.createdAt,
          conversationId: 'mock-direct',
          conversationType: ConversationType.direct,
          message: message,
          senderName: 'الأستاذ عبدالله',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('رسالة وصلت الآن'), findsOneWidget);
    });

    testWidgets('says so while the connection is being re-established', (
      tester,
    ) async {
      await open(tester, '/messages/mock-direct', extra: live());
      expect(find.textContaining('جارٍ إعادة الاتصال'), findsNothing);

      realtime.setStatus(RealtimeStatus.reconnecting);
      await tester.pump();
      expect(find.textContaining('جارٍ إعادة الاتصال'), findsOneWidget);

      realtime.setStatus(RealtimeStatus.reconnected);
      await tester.pumpAndSettle();
      expect(find.textContaining('جارٍ إعادة الاتصال'), findsNothing);
    });

    testWidgets('closes the composer once the viewer is removed', (
      tester,
    ) async {
      await open(tester, '/messages/mock-group', extra: live());
      expect(find.byType(TextField), findsOneWidget);

      realtime.emit(
        ParticipantRemovedEvent(
          eventId: 'participant.removed:1',
          occurredAt: DateTime.now(),
          conversationId: 'mock-group',
          userId: MockMessagingRepository.viewer,
          reason: 'removed',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);
      expect(find.textContaining('لم تعد عضوًا'), findsOneWidget);
    });
  });

  testWidgets('is reachable from the profile', (tester) async {
    await open(tester, '/profile');
    await tester.scrollUntilVisible(find.text('الرسائل'), 200);
    await tester.tap(find.text('الرسائل'));
    await tester.pumpAndSettle();
    expect(find.text('الأستاذ عبدالله'), findsOneWidget);
  });

  // The viewer owns `ownedId` (its chat), so its community `me` grants
  // `community.messages.moderate`; they are a plain member of `openId`'s chat.
  // Moderation authority comes from the community, never the conversation
  // (ADR 0029) — the demo's MockCommunityRepository provides it here.
  group('community chat moderation (ADR 0029)', () {
    const ownedChat = '${MockCommunityRepository.ownedId}-chat';
    const openChat = '${MockCommunityRepository.openId}-chat';
    const line = 'نلتقي بعد صلاة المغرب لمراجعة الورد.';

    testWidgets('a moderator deletes a message, then reviews its original', (
      tester,
    ) async {
      await open(tester, '/messages/$ownedChat');
      expect(find.text(line), findsOneWidget);

      // Long-press → the moderator sheet → delete, then confirm.
      await tester.longPress(find.text(line));
      await tester.pumpAndSettle();
      expect(find.text(MessagingCopy.moderateDelete), findsOneWidget);
      await tester.tap(find.text(MessagingCopy.moderateDelete));
      await tester.pumpAndSettle();
      expect(find.text(MessagingCopy.moderateDeleteTitle), findsOneWidget);
      await tester.tap(find.text(MessagingCopy.moderateDeleteConfirm));
      await tester.pumpAndSettle();

      // The message now reads as a tombstone; the original is gone from view.
      expect(find.text('تم حذف هذه الرسالة'), findsOneWidget);
      expect(find.text(line), findsNothing);
      expect(find.text(MessagingCopy.moderateDeleteDone), findsOneWidget);

      // Long-press the tombstone → review → the original is disclosed.
      await tester.longPress(find.text('تم حذف هذه الرسالة'));
      await tester.pumpAndSettle();
      expect(find.text(MessagingCopy.reviewOriginal), findsOneWidget);
      await tester.tap(find.text(MessagingCopy.reviewOriginal));
      await tester.pumpAndSettle();
      expect(find.text(MessagingCopy.reviewTitle), findsOneWidget);
      expect(find.text(line), findsOneWidget); // the original, in the dialog
    });

    testWidgets('a plain member is offered no moderation', (tester) async {
      await open(tester, '/messages/$openChat');
      // A readable message is shown, but a long-press offers nothing.
      final message = find.byType(MessageBubble).first;
      expect(message, findsOneWidget);
      await tester.longPress(message);
      await tester.pumpAndSettle();
      expect(find.text(MessagingCopy.moderateDelete), findsNothing);
      expect(find.text(MessagingCopy.reviewOriginal), findsNothing);
    });

    // Pinned messages (ADR 0043): a moderator pins and unpins; the banner shows
    // the pinned message's preview; a plain member is offered no pin action.
    testWidgets('a moderator pins a message, the banner shows it, then unpins', (
      tester,
    ) async {
      await open(tester, '/messages/$ownedChat');
      expect(find.byKey(const Key('pinned-message-banner')), findsNothing);

      await tester.longPress(find.text(line));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('message-pin-action')));
      await tester.pumpAndSettle();

      // The banner appears, previewing the pinned message.
      final banner = find.byKey(const Key('pinned-message-banner'));
      expect(banner, findsOneWidget);
      expect(find.descendant(of: banner, matching: find.text(line)), findsOneWidget);

      // The moderator unpins from the banner; it disappears, the message stays.
      await tester.tap(find.byKey(const Key('pinned-message-unpin')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pinned-message-banner')), findsNothing);
      expect(find.text(line), findsOneWidget); // the message itself is untouched
    });

    testWidgets('a plain member is offered no pin action', (tester) async {
      await open(tester, '/messages/$openChat');
      await tester.longPress(find.byType(MessageBubble).first);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-pin-action')), findsNothing);
      expect(find.byKey(const Key('message-unpin-action')), findsNothing);
    });
  });

  // Phase 2: the community chat's header (picture + name) opens the community's
  // own info & management page — the existing one, never a second screen — and
  // what that page offers is the server's `me` to decide.
  group('community chat header → info & management (Phase 2)', () {
    const ownedChat = '${MockCommunityRepository.ownedId}-chat';
    const openChat = '${MockCommunityRepository.openId}-chat';
    const header = Key('conversation-community-header');

    testWidgets('tapping the header opens the community info page', (
      tester,
    ) async {
      await open(tester, '/messages/$ownedChat');
      expect(find.byKey(header), findsOneWidget);

      await tester.tap(find.byKey(header));
      await tester.pumpAndSettle();
      // The existing community page — not a duplicate — is now on top.
      expect(find.byType(CommunityScreen), findsOneWidget);
    });

    testWidgets('a direct conversation has no tappable community header', (
      tester,
    ) async {
      await open(tester, '/messages/mock-direct');
      expect(find.byType(TextField), findsWidgets); // the chat did open
      expect(find.byKey(header), findsNothing);
    });

    testWidgets('the owner reaches the edit affordance from the header', (
      tester,
    ) async {
      await open(tester, '/messages/$ownedChat');
      await tester.tap(find.byKey(header));
      await tester.pumpAndSettle();
      // The owner holds community.profile.edit, so the page offers editing.
      expect(find.byTooltip(CommunityCopy.editCommunity), findsOneWidget);
    });

    testWidgets('a plain member reaches the page but not the edit affordance', (
      tester,
    ) async {
      await open(tester, '/messages/$openChat');
      await tester.tap(find.byKey(header));
      await tester.pumpAndSettle();
      expect(find.byType(CommunityScreen), findsOneWidget);
      // No capability → the server's `me` withholds editing, and so does the UI.
      expect(find.byTooltip(CommunityCopy.editCommunity), findsNothing);
    });
  });

  // Phase 3: a "live now" bar appears under the app bar of a community chat
  // only while the server reports a running session for THAT community, opens
  // the existing live screen, and tracks start/end/reconnect via the shared
  // liveSessionProvider. It never claims audio/video work (fake provider).
  group('community live indicator (Phase 3)', () {
    const ownedChat = '${MockCommunityRepository.ownedId}-chat';
    final indicator = find.byKey(const Key('community-live-indicator'));

    Override liveWith(Set<String> live) => liveRepositoryProvider
        .overrideWithValue(MockLiveRepository(liveCommunityIds: live));

    testWidgets('shows a live-now bar when the community has an active session', (
      tester,
    ) async {
      await open(
        tester,
        '/messages/$ownedChat',
        extra: [liveWith({MockCommunityRepository.ownedId})],
      );
      expect(indicator, findsOneWidget);
      expect(find.text(MessagingCopy.liveNow), findsOneWidget);
    });

    testWidgets('shows nothing when no session is live', (tester) async {
      await open(
        tester,
        '/messages/$ownedChat',
        extra: [liveWith(const {})],
      );
      expect(indicator, findsNothing);
    });

    testWidgets('does not leak another community\'s live session', (
      tester,
    ) async {
      // openId is live, but the viewer is in ownedId's chat — keyed per id.
      await open(
        tester,
        '/messages/$ownedChat',
        extra: [liveWith({MockCommunityRepository.openId})],
      );
      expect(indicator, findsNothing);
    });

    testWidgets('a direct conversation has no live indicator', (tester) async {
      await open(tester, '/messages/mock-direct');
      expect(indicator, findsNothing);
    });

    testWidgets('tapping it opens the community live session screen', (
      tester,
    ) async {
      await open(
        tester,
        '/messages/$ownedChat',
        extra: [liveWith({MockCommunityRepository.ownedId})],
      );
      await tester.tap(indicator);
      await tester.pumpAndSettle();
      expect(find.byType(LiveSessionScreen), findsOneWidget);
    });

    testWidgets('appears when a session starts and clears when it ends', (
      tester,
    ) async {
      final realtime = FakeRealtimeClient();
      final fake = _FakeLive(MockCommunityRepository.ownedId);
      await open(
        tester,
        '/messages/$ownedChat',
        extra: [
          liveRepositoryProvider.overrideWithValue(fake),
          realtimeConnectionProvider.overrideWithValue(realtime),
        ],
      );
      expect(indicator, findsNothing);

      // A start hint arrives; the provider re-reads and now sees a session.
      fake.current = _liveSession(MockCommunityRepository.ownedId);
      realtime.emit(
        LiveSessionStartedEvent(
          eventId: 'live.session.started:s-1',
          occurredAt: DateTime.now(),
          communityId: MockCommunityRepository.ownedId,
          sessionId: 'live-${MockCommunityRepository.ownedId}',
        ),
      );
      await tester.pumpAndSettle();
      expect(indicator, findsOneWidget);

      // The session ends; a re-read now finds it ended and the bar clears.
      fake.current = null;
      realtime.emit(
        LiveSessionEndedEvent(
          eventId: 'live.session.ended:s-1',
          occurredAt: DateTime.now(),
          communityId: MockCommunityRepository.ownedId,
          sessionId: 'live-${MockCommunityRepository.ownedId}',
          reason: LiveSessionEndReason.moderator,
        ),
      );
      await tester.pumpAndSettle();
      expect(indicator, findsNothing);
    });

    testWidgets('restores the correct state after a reconnect', (tester) async {
      final realtime = FakeRealtimeClient();
      final fake = _FakeLive(MockCommunityRepository.ownedId);
      await open(
        tester,
        '/messages/$ownedChat',
        extra: [
          liveRepositoryProvider.overrideWithValue(fake),
          realtimeConnectionProvider.overrideWithValue(realtime),
        ],
      );
      expect(indicator, findsNothing);

      // A session started while the client was away (no event seen). On
      // reconnect the provider re-reads and the bar comes back correctly.
      fake.current = _liveSession(MockCommunityRepository.ownedId);
      realtime.setStatus(RealtimeStatus.reconnected);
      await tester.pumpAndSettle();
      expect(indicator, findsOneWidget);
    });
  });

  // The Telegram-inspired rendering, over real model fields only: a reply quote
  // (replyToMessageId), consecutive-sender grouping, and an avatar in every
  // chat header. No reactions, pins or read receipts are rendered — the model
  // carries none.
  group('chat rendering', () {
    testWidgets('a reply shows a quote of the message it answers', (
      tester,
    ) async {
      await open(tester, '/messages/mock-group');
      // The seeded reply sits earlier in the history; scroll up to it.
      final quote = find.byKey(const Key('message-reply-preview'));
      await tester.scrollUntilVisible(
        quote,
        300,
        scrollable: find.byType(Scrollable).first,
      );
      expect(quote, findsOneWidget);
      // The quote names the original sender (the teacher it answers).
      expect(
        find.descendant(of: quote, matching: find.text('الأستاذ عبدالله')),
        findsOneWidget,
      );
    });

    testWidgets(
      'a reply to a deleted message quotes it as a tombstone, never its content',
      (tester) async {
        const ownedChat = '${MockCommunityRepository.ownedId}-chat';
        const line = 'نلتقي بعد صلاة المغرب لمراجعة الورد.';

        // A reply is sent to the seeded message, then that target is moderated
        // away — the deleted-reply lifecycle the audit (P3-2) covers.
        final target = (await repo.messages(ownedChat)).items.first;
        await repo.sendText(
          ownedChat,
          clientMessageId: 'reply-del-render',
          body: 'ما شاء الله',
          replyToMessageId: target.id,
        );
        await repo.deleteMessage(ownedChat, target.id);

        await open(tester, '/messages/$ownedChat');

        // The reply still renders with a quote, but the quote resolves to the
        // neutral tombstone label — the deleted words appear nowhere on screen.
        final quote = find.byKey(const Key('message-reply-preview'));
        expect(quote, findsOneWidget);
        expect(
          find.descendant(of: quote, matching: find.text('رسالة محذوفة')),
          findsOneWidget,
        );
        expect(find.text(line), findsNothing);
        expect(find.text('تم حذف هذه الرسالة'), findsOneWidget);
      },
    );

    testWidgets('consecutive messages from one sender show the name once', (
      tester,
    ) async {
      // The channel is three posts in a row from the same sender.
      await open(tester, '/messages/mock-channel');
      expect(find.text('إدارة المعهد'), findsOneWidget);
      expect(find.text('يبدأ التسجيل في دورة التجويد المكثفة يوم الأحد.'),
          findsOneWidget);
    });

    testWidgets('every chat header carries an avatar, direct chats included', (
      tester,
    ) async {
      await open(tester, '/messages/mock-direct');
      expect(
        find.descendant(of: find.byType(AppBar), matching: find.byType(AppAvatar)),
        findsOneWidget,
      );
      // A direct header is not a tappable community button.
      expect(
        find.byKey(const Key('conversation-community-header')),
        findsNothing,
      );
    });
  });

  // The reply workflow end to end over the mock backend: start from a message,
  // see the quote above the composer, send, and watch the reply render with its
  // quote. Reply is backed for text messages (the server validates the target).
  group('reply workflow', () {
    const target = 'تنبيه الحلقة رقم 36: راجعوا الوجه المقرر قبل الفجر.';

    Future<void> startReply(WidgetTester tester) async {
      await tester.longPress(find.text(target));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('message-reply-action')));
      await tester.pumpAndSettle();
    }

    testWidgets('long-press → رد shows a quote banner above the composer', (
      tester,
    ) async {
      await open(tester, '/messages/mock-group');
      await startReply(tester);
      final banner = find.byKey(const Key('composer-reply-banner'));
      expect(banner, findsOneWidget);
      expect(
        find.descendant(
          of: banner,
          matching: find.text(MessagingCopy.replyingTo('الأستاذ عبدالله')),
        ),
        findsOneWidget,
      );
    });

    testWidgets('cancelling the reply removes the banner', (tester) async {
      await open(tester, '/messages/mock-group');
      await startReply(tester);
      await tester.tap(find.byKey(const Key('composer-reply-cancel')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('composer-reply-banner')), findsNothing);
    });

    testWidgets('sending the reply quotes the original and clears the banner', (
      tester,
    ) async {
      await open(tester, '/messages/mock-group');
      await startReply(tester);
      await tester.enterText(find.byType(TextField), 'شكرًا على التنبيه');
      await tester.pump();
      await tester.tap(find.byTooltip('إرسال'));
      await tester.pumpAndSettle();

      // Banner gone; the reply is in the timeline, quoting the original sender.
      expect(find.byKey(const Key('composer-reply-banner')), findsNothing);
      expect(find.text('شكرًا على التنبيه'), findsOneWidget);
      expect(find.byKey(const Key('message-reply-preview')), findsWidgets);

      // The relationship reached the backend on the right message.
      final stored = await repo.messages('mock-group');
      final original = stored.items.firstWhere((m) => m.body == target);
      final reply = stored.items.firstWhere(
        (m) => m.body == 'شكرًا على التنبيه',
      );
      expect(reply.replyToMessageId, original.id);
    });

    testWidgets('a read-only channel offers no reply action', (tester) async {
      await open(tester, '/messages/mock-channel');
      await tester.longPress(
        find.text('يبدأ التسجيل في دورة التجويد المكثفة يوم الأحد.'),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('message-reply-action')), findsNothing);
    });

    testWidgets('replying then attaching an image sends the image as a reply', (
      tester,
    ) async {
      await open(
        tester,
        '/messages/mock-group',
        extra: [attachmentPickerProvider.overrideWithValue(FakePicker())],
      );
      await startReply(tester);
      expect(find.byKey(const Key('composer-reply-banner')), findsOneWidget);

      // Attach an image while the reply is active — the target survives picking.
      await tester.tap(find.byTooltip('إرفاق ملف'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('صورة'));
      await tester.pumpAndSettle();

      // The banner cleared; the image message carries the reply relationship.
      expect(find.byKey(const Key('composer-reply-banner')), findsNothing);
      final stored = await repo.messages('mock-group');
      final original = stored.items.firstWhere((m) => m.body == target);
      final image = stored.items.lastWhere(
        (m) => m.type == MessageType.image,
      );
      expect(image.replyToMessageId, original.id);
    });
  });

  // Real-time pin synchronization (ADR 0043): a remote message.pinned event
  // updates the banner without reopening; ordering and cross-conversation
  // isolation and reconnect recovery behave per the event contract.
  group('pinned messages — realtime', () {
    const ownedChat = '${MockCommunityRepository.ownedId}-chat';
    const pinnedId = '${MockCommunityRepository.ownedId}-chat-m1';
    const pinnedBody = 'نلتقي بعد صلاة المغرب لمراجعة الورد.';
    late FakeRealtimeClient realtime;
    setUp(() => realtime = FakeRealtimeClient());
    List<Override> live() => [
      realtimeConnectionProvider.overrideWithValue(realtime),
    ];

    MessagePinnedEvent pinEvent(
      String? id, {
      required int version,
      String? conversation,
      DateTime? at,
    }) => MessagePinnedEvent(
      eventId: 'message.pinned:${conversation ?? ownedChat}:$version',
      occurredAt: at ?? DateTime(2026, 1, 1, version),
      conversationId: conversation ?? ownedChat,
      pinnedMessageId: id,
      pinVersion: version,
    );

    testWidgets('a remote pin shows the banner, then a remote unpin removes it', (
      tester,
    ) async {
      await open(tester, '/messages/$ownedChat', extra: live());
      expect(find.byKey(const Key('pinned-message-banner')), findsNothing);

      realtime.emit(pinEvent(pinnedId, version: 1));
      await tester.pumpAndSettle();
      final banner = find.byKey(const Key('pinned-message-banner'));
      expect(banner, findsOneWidget);
      expect(find.descendant(of: banner, matching: find.text(pinnedBody)), findsOneWidget);

      realtime.emit(pinEvent(null, version: 2));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pinned-message-banner')), findsNothing);
    });

    testWidgets('a replacement event updates the preview', (tester) async {
      await open(tester, '/messages/$ownedChat', extra: live());
      realtime.emit(pinEvent(pinnedId, version: 1));
      await tester.pumpAndSettle();
      // A replacement to a message id not loaded → truthful fallback preview.
      realtime.emit(pinEvent('no-such-message', version: 2));
      await tester.pumpAndSettle();
      final banner = find.byKey(const Key('pinned-message-banner'));
      expect(banner, findsOneWidget);
      expect(find.descendant(of: banner, matching: find.text(pinnedBody)), findsNothing);
      expect(
        find.descendant(of: banner, matching: find.text(MessagingCopy.pinnedUnavailable)),
        findsOneWidget,
      );
    });

    testWidgets('a pin event for another conversation is ignored', (tester) async {
      await open(tester, '/messages/$ownedChat', extra: live());
      realtime.emit(pinEvent(pinnedId, version: 1, conversation: 'some-other-chat'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pinned-message-banner')), findsNothing);
    });

    testWidgets('an older version does not regress newer state, even at an '
        'equal timestamp', (tester) async {
      await open(tester, '/messages/$ownedChat', extra: live());
      final sameInstant = DateTime(2026, 5, 1, 9);
      // Newer pin (version 2) applied first.
      realtime.emit(pinEvent(pinnedId, version: 2, at: sameInstant));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pinned-message-banner')), findsOneWidget);
      // An older unpin (version 1) at the SAME timestamp must NOT clear it:
      // version, not time, decides.
      realtime.emit(pinEvent(null, version: 1, at: sameInstant));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pinned-message-banner')), findsOneWidget);
      // A duplicate of the newer event is idempotent.
      realtime.emit(pinEvent(pinnedId, version: 2, at: sameInstant));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pinned-message-banner')), findsOneWidget);
    });

    testWidgets('reconnect recovers a pin set while disconnected', (tester) async {
      await open(tester, '/messages/$ownedChat', extra: live());
      expect(find.byKey(const Key('pinned-message-banner')), findsNothing);
      // A change missed while away: the server now has a pin.
      await repo.pinMessage(ownedChat, pinnedId);
      realtime.setStatus(RealtimeStatus.reconnected);
      await tester.pumpAndSettle();
      // The re-read on reconnect recovers it authoritatively.
      expect(find.byKey(const Key('pinned-message-banner')), findsOneWidget);
    });
  });
}
