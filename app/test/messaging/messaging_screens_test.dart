import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/media/media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
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
  }) async {
    if (failSends > 0) {
      failSends--;
      throw const MessagingException('network.unreachable', 'offline');
    }
    return super.sendText(
      conversationId,
      clientMessageId: clientMessageId,
      body: body,
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
    'lists conversations with previews and unread badges, flagged as demo data',
    (tester) async {
      await open(tester, '/messages');
      expect(find.text('حلقة الفجر — التلاوة'), findsOneWidget);
      expect(find.text('الأستاذ عبدالله'), findsOneWidget);
      expect(find.text('إعلانات المعهد'), findsOneWidget);
      expect(find.textContaining('محادثات تجريبية'), findsOneWidget);
      // mock-group: 36 messages, read to 31, five unread — four from others.
      expect(find.text('4'), findsOneWidget);
    },
  );

  testWidgets('caps the unread badge at 99+', (tester) async {
    repo.unreadOverride = 100;
    await open(tester, '/messages');
    // One badge per listed conversation — the demo's community chats too.
    final listed = (await repo.conversations()).items.length;
    expect(listed, greaterThan(3));
    expect(find.text('99+'), findsNWidgets(listed));
  });

  testWidgets('opens a conversation, shows who said what, and marks it read', (
    tester,
  ) async {
    await open(tester, '/messages');
    await tester.tap(find.text('حلقة الفجر — التلاوة'));
    await tester.pumpAndSettle();

    expect(find.textContaining('تنبيه الحلقة رقم 36'), findsOneWidget);
    expect(
      find.text('الأستاذ عبدالله'),
      findsWidgets,
    ); // sender names in a group
    expect(find.text('رسائل جديدة'), findsOneWidget);
    expect((await repo.conversation('mock-group')).lastReadSequence, 36);
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
    expect(find.text('حلقة الفجر — التلاوة'), findsOneWidget);
  });

  testWidgets('loads the next page of conversations on request', (
    tester,
  ) async {
    final seed = await MockMessagingRepository(latency: Duration.zero)
        .conversation('mock-direct');
    repo.extraPage = [
      Conversation(
        id: 'page-two',
        type: ConversationType.group,
        title: 'حلقة العصر',
        memberCount: 3,
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
    expect(find.text('حلقة العصر'), findsNothing);
    await tester.scrollUntilVisible(find.text('عرض المزيد'), 200);
    await tester.tap(find.text('عرض المزيد'));
    await tester.pumpAndSettle();
    expect(find.text('حلقة العصر'), findsOneWidget);
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
    expect(find.text('حلقة الفجر — التلاوة'), findsOneWidget);
  });
}
