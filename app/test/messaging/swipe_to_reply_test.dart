import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/features/messaging/widgets/swipe_to_reply.dart';

/// The swipe-to-reply affordance: a drag past the threshold fires the reply
/// once; a short drag does not; and it is inert when replying is not allowed.
void main() {
  Widget host(VoidCallback? onReply) => MaterialApp(
    home: Scaffold(
      body: Center(
        child: SwipeToReply(
          onReply: onReply,
          child: const SizedBox(width: 200, height: 48, child: Text('رسالة')),
        ),
      ),
    ),
  );

  testWidgets('a drag past the threshold fires reply exactly once', (
    tester,
  ) async {
    var replies = 0;
    await tester.pumpWidget(host(() => replies++));
    await tester.drag(
      find.text('رسالة'),
      const Offset(SwipeToReply.threshold + 24, 0),
    );
    await tester.pumpAndSettle();
    expect(replies, 1);
  });

  testWidgets('a short drag does not fire reply', (tester) async {
    var replies = 0;
    await tester.pumpWidget(host(() => replies++));
    await tester.drag(
      find.text('رسالة'),
      const Offset(SwipeToReply.threshold - 24, 0),
    );
    await tester.pumpAndSettle();
    expect(replies, 0);
  });

  testWidgets('is inert when replying is not allowed (onReply null)', (
    tester,
  ) async {
    await tester.pumpWidget(host(null));
    await tester.drag(
      find.text('رسالة'),
      const Offset(SwipeToReply.threshold + 24, 0),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('رسالة'), findsOneWidget);
  });
}
