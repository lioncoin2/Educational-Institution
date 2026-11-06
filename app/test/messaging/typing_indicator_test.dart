import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/features/messaging/widgets/typing_indicator.dart';

/// The typing indicator (Phase 3): a `typing` frame parses into a [TypingEvent],
/// and the strip names who is typing — nothing while the set is empty.
void main() {
  test('a typing frame parses conversation and user', () {
    final frame = ServerFrame.parse(
      jsonEncode({
        'type': 'typing',
        'conversationId': 'c1',
        'userId': 'u2',
        'version': 1,
      }),
    );
    expect(frame, isA<TypingEvent>());
    final typing = frame as TypingEvent;
    expect(typing.conversationId, 'c1');
    expect(typing.userId, 'u2');
  });

  test('a typing frame missing ids is dropped', () {
    expect(
      ServerFrame.parse(
        jsonEncode({'type': 'typing', 'conversationId': 'c1', 'version': 1}),
      ),
      isNull,
    );
  });

  Widget host(Widget child) =>
      MaterialApp(home: Scaffold(body: Directionality(
        textDirection: TextDirection.rtl,
        child: child,
      )));

  testWidgets('shows nothing when no one is typing', (tester) async {
    await tester.pumpWidget(host(
      TypingIndicator(userIds: const {}, nameOf: (_) => 'x'),
    ));
    expect(find.byType(Text), findsNothing);
  });

  testWidgets('names one typist', (tester) async {
    await tester.pumpWidget(host(
      TypingIndicator(
        userIds: const {'u2'},
        nameOf: (id) => id == 'u2' ? 'سارة' : null,
      ),
    ));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('سارة'), findsOneWidget);
    expect(find.textContaining('يكتب'), findsOneWidget);
  });

  testWidgets('falls back to a neutral word for an unknown typist',
      (tester) async {
    await tester.pumpWidget(host(
      TypingIndicator(userIds: const {'ghost'}, nameOf: (_) => null),
    ));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('عضو'), findsOneWidget);
  });
}
