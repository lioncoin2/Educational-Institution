import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/widgets/message_bubble.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Opening published/sent media as a recipient (Requirement C): an image opens
/// to a full-screen zoomable viewer, a file resolves its short-lived signed
/// link and opens it (web-only here, with an honest fallback), and an http/https
/// link in a text message is a tappable span while an unsafe scheme stays inert.
class _FakeMessaging extends MockMessagingRepository {
  _FakeMessaging() : super(latency: Duration.zero);

  int urlCalls = 0;

  @override
  Future<Uri> attachmentUrl(
    String conversationId,
    String messageId,
    String fileAssetId,
  ) async {
    urlCalls++;
    return Uri.parse('https://files.example.org/$fileAssetId?sig=x');
  }
}

Attachment _att({bool available = true, String? name}) => Attachment(
  fileAssetId: 'asset-1',
  available: available,
  byteSize: 2048,
  displayName: name,
  width: 800,
  height: 600,
);

Message _msg(MessageType type, {Attachment? att, String? body}) => Message(
  id: 'm1',
  conversationId: 'c1',
  sequence: 1,
  senderId: 'u-teacher',
  type: type,
  createdAt: DateTime.utc(2026, 9, 1),
  body: body,
  attachments: att == null ? const [] : [att],
);

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  _FakeMessaging? repo,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        if (repo != null) messagingRepositoryProvider.overrideWithValue(repo),
      ],
      child: MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: Scaffold(body: child),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('image', () {
    testWidgets('tapping it opens a full-screen viewer, and it closes', (
      tester,
    ) async {
      final repo = _FakeMessaging();
      final att = _att(name: 'board.png');
      await _pump(
        tester,
        ImageAttachment(
          message: _msg(MessageType.image, att: att),
          attachment: att,
        ),
        repo: repo,
      );
      expect(repo.urlCalls, 1); // the thumbnail resolved its signed link

      await tester.tap(find.byKey(const Key('image-attachment-open')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('image-viewer')), findsOneWidget);
      expect(find.byType(InteractiveViewer), findsOneWidget);

      await tester.tap(find.byKey(const Key('image-viewer-close')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('image-viewer')), findsNothing);
    });
  });

  group('file', () {
    testWidgets('tapping it resolves the signed link and opens it', (
      tester,
    ) async {
      final repo = _FakeMessaging();
      final att = _att(name: 'notes.pdf');
      await _pump(
        tester,
        FileAttachment(
          message: _msg(MessageType.file, att: att),
          attachment: att,
        ),
        repo: repo,
      );
      expect(find.text('notes.pdf'), findsOneWidget);

      await tester.tap(find.byKey(const Key('file-attachment')));
      await tester.pumpAndSettle();
      // The link was resolved; on this (non-web) build opening falls back to a
      // clear message rather than failing silently.
      expect(repo.urlCalls, 1);
      expect(
        find.text('فتح الملفات متاح على الويب في هذا الإصدار'),
        findsOneWidget,
      );
    });

    testWidgets('an unavailable file is shown but not tappable', (
      tester,
    ) async {
      final repo = _FakeMessaging();
      final att = _att(available: false, name: 'gone.pdf');
      await _pump(
        tester,
        FileAttachment(
          message: _msg(MessageType.file, att: att),
          attachment: att,
        ),
        repo: repo,
      );
      expect(find.text('gone.pdf'), findsOneWidget);
      expect(find.text('الملف غير متاح'), findsOneWidget);

      await tester.tap(find.byKey(const Key('file-attachment')));
      await tester.pumpAndSettle();
      expect(repo.urlCalls, 0); // onTap is null for an unavailable file
    });
  });

  group('link', () {
    testWidgets('an https link is a tappable span; javascript: stays inert', (
      tester,
    ) async {
      await _pump(
        tester,
        const MessageText('راجع https://example.org/x ثم javascript:alert(1)'),
      );
      final rich = tester.widget<RichText>(
        find
            .descendant(
              of: find.byType(MessageText),
              matching: find.byType(RichText),
            )
            .first,
      );
      final linked = <String>[];
      void walk(InlineSpan span) {
        if (span is TextSpan) {
          if (span.recognizer != null && span.text != null) {
            linked.add(span.text!);
          }
          for (final child in span.children ?? const <InlineSpan>[]) {
            walk(child);
          }
        }
      }

      walk(rich.text);
      expect(linked, contains('https://example.org/x'));
      expect(linked.any((t) => t.contains('javascript')), isFalse);
    });

    testWidgets('plain text with no link renders as plain text', (
      tester,
    ) async {
      await _pump(tester, const MessageText('مرحبًا بالجميع'));
      expect(find.text('مرحبًا بالجميع'), findsOneWidget);
    });
  });
}
