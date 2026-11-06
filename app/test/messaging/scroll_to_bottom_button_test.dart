import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/features/messaging/widgets/scroll_to_bottom_button.dart';

/// The jump-to-newest button: hidden (and inert) while [show] is false, visible
/// and tappable when true, and badged with the unread count.
void main() {
  Widget host(
    ValueNotifier<bool> show, {
    int unread = 0,
    VoidCallback? onTap,
  }) => MaterialApp(
    home: Scaffold(
      body: ScrollToBottomButton(
        show: show,
        unread: unread,
        onTap: onTap ?? () {},
      ),
    ),
  );

  testWidgets('shows the unread count when there is one', (tester) async {
    await tester.pumpWidget(host(ValueNotifier(true), unread: 5));
    await tester.pumpAndSettle();
    expect(find.text('5'), findsOneWidget);
    expect(find.byIcon(Icons.keyboard_arrow_down_rounded), findsOneWidget);
  });

  testWidgets('caps the badge at 99+', (tester) async {
    await tester.pumpWidget(host(ValueNotifier(true), unread: 240));
    await tester.pumpAndSettle();
    expect(find.text('99+'), findsOneWidget);
  });

  testWidgets('tapping jumps (calls onTap) when visible', (tester) async {
    var taps = 0;
    await tester.pumpWidget(host(ValueNotifier(true), onTap: () => taps++));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(FloatingActionButton));
    expect(taps, 1);
  });

  testWidgets('is inert while hidden (ignores taps)', (tester) async {
    var taps = 0;
    final show = ValueNotifier(false);
    await tester.pumpWidget(host(show, onTap: () => taps++));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(FloatingActionButton), warnIfMissed: false);
    expect(taps, 0);
  });
}
