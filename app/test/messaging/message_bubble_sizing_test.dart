import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/widgets/message_bubble.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// A bubble sizes to its content: a short message gets a short bubble, a long
/// one stops at the cap (78% of the screen, at most 520) and wraps, and the
/// time sits at the content's end edge — never a full-width bar for "سلام".
class _FakeMessaging extends MockMessagingRepository {
  _FakeMessaging() : super(latency: Duration.zero);

  @override
  Future<Uri> attachmentUrl(
    String conversationId,
    String messageId,
    String fileAssetId,
  ) async => Uri.parse('https://files.example.org/$fileAssetId');
}

const _screen = Size(390, 844);
const _cap = 390 * 0.78; // the bubble's maximum width on this screen

Message _text(String body) => Message(
  id: 'm1',
  conversationId: 'c1',
  sequence: 1,
  senderId: 'u-1',
  type: MessageType.text,
  createdAt: DateTime.utc(2026, 9, 1, 10, 5),
  body: body,
);

Message _media(MessageType type) => Message(
  id: 'm2',
  conversationId: 'c1',
  sequence: 2,
  senderId: 'u-1',
  type: type,
  createdAt: DateTime.utc(2026, 9, 1, 10, 6),
  attachments: const [
    Attachment(
      fileAssetId: 'asset-1',
      available: true,
      byteSize: 2048,
      displayName: 'board.png',
      width: 800,
      height: 600,
      durationMs: 4000,
    ),
  ],
);

Future<void> _pump(WidgetTester tester, Widget bubble) async {
  tester.view.physicalSize = _screen;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        messagingRepositoryProvider.overrideWithValue(_FakeMessaging()),
      ],
      child: MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: Scaffold(body: ListView(children: [bubble])),
        ),
      ),
    ),
  );
  await tester.pump();
}

Size _frame(WidgetTester tester) =>
    tester.getSize(find.byKey(const Key('message-bubble-frame')));

void main() {
  for (final mine in [true, false]) {
    final who = mine ? 'my' : "someone else's";

    testWidgets('$who short message gets a short bubble', (tester) async {
      await _pump(tester, MessageBubble(message: _text('سلام'), mine: mine));
      expect(_frame(tester).width, lessThan(_cap / 2));
    });

    testWidgets('$who long message stops at the cap and wraps', (tester) async {
      await _pump(
        tester,
        MessageBubble(message: _text('هذه رسالة طويلة جدًا ' * 12), mine: mine),
      );
      expect(_frame(tester).width, moreOrLessEquals(_cap, epsilon: 0.5));
      expect(_frame(tester).height, greaterThan(80)); // several lines
    });
  }

  testWidgets('a reply quote does not force a short reply to full width', (
    tester,
  ) async {
    await _pump(
      tester,
      MessageBubble(
        message: _text('نعم'),
        mine: true,
        repliedTo: const RepliedMessage(preview: 'متى الدرس؟'),
      ),
    );
    // As wide as the quote it carries (plus the 12 + 12 padding), not the cap.
    final quote = tester.getSize(
      find.byKey(const Key('message-reply-preview')),
    );
    expect(
      _frame(tester).width,
      moreOrLessEquals(quote.width + 24, epsilon: 0.5),
    );
    expect(_frame(tester).width, lessThan(_cap - 1));
  });

  testWidgets('an image bubble is as wide as its picture, never collapsed', (
    tester,
  ) async {
    await _pump(
      tester,
      MessageBubble(message: _media(MessageType.image), mine: false),
    );
    // The picture's 260px plus the bubble's horizontal padding (12 + 12).
    expect(_frame(tester).width, moreOrLessEquals(284, epsilon: 0.5));
  });

  testWidgets('a voice bubble fits its player', (tester) async {
    await _pump(
      tester,
      MessageBubble(message: _media(MessageType.voice), mine: true),
    );
    // Exactly the player's width plus the bubble's padding, not the cap.
    final player = tester.getSize(find.byType(VoiceAttachment));
    expect(
      _frame(tester).width,
      moreOrLessEquals(player.width + 24, epsilon: 0.5),
    );
    expect(_frame(tester).width, lessThan(_cap - 1));
  });

  testWidgets('the time sits at the end edge of the content (RTL: left)', (
    tester,
  ) async {
    await _pump(
      tester,
      MessageBubble(message: _text('رسالة بطول متوسط هنا'), mine: false),
    );
    final frame = tester.getRect(find.byKey(const Key('message-bubble-frame')));
    final time = tester.getRect(find.textContaining(RegExp(r'\d')).last);
    // End edge in RTL is the left: the time hugs the left padding.
    expect(time.left, moreOrLessEquals(frame.left + 12, epsilon: 1));
  });
}
