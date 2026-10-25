import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/state/live_media_controller.dart';
import 'package:quran_institution_app/features/live/widgets/live_active_bar.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'fake_live_media_client.dart';

/// The app-wide live bar: a viewer who navigates away from a live room stays in
/// it, and every OTHER screen says so — with the real mic state, a way back and
/// an explicit leave. The room itself shows no bar, and the bar coming and
/// going never rebuilds the routed screens.
void main() {
  const active = LiveActiveSession(communityId: 'c-1', sessionId: 's-1');

  late FakeLiveMediaClient client;
  late ProviderContainer container;
  late GoRouter router;

  Future<void> pump(WidgetTester tester) async {
    client = FakeLiveMediaClient(initial: const LiveMediaConnected());
    addTearDown(client.dispose);
    container = ProviderContainer(
      overrides: [liveMediaClientProvider.overrideWithValue(client)],
    );
    addTearDown(container.dispose);
    router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (_, _) => const _CounterPage()),
        GoRoute(
          path: '/communities/:communityId/live',
          builder: (_, _) => const Scaffold(body: Text('live room')),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(
          routerConfig: router,
          builder: (context, child) =>
              LiveActiveBarHost(router: router, child: child!),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('no live room → no bar', (tester) async {
    await pump(tester);
    expect(find.byKey(const Key('live-active-bar')), findsNothing);
  });

  testWidgets('a live room shows the bar elsewhere, with the real mic state, '
      'and never resets the screen under it', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('counter-add')));
    await tester.pump();
    expect(find.text('count 1'), findsOneWidget);

    container.read(liveActiveSessionProvider.notifier).enter(active);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('live-active-bar')), findsOneWidget);
    expect(find.text(LiveCopy.activeBarTitle), findsOneWidget);
    // The page kept its state: the bar did not rebuild the navigator.
    expect(find.text('count 1'), findsOneWidget);

    client.emitPublication(const LiveMediaPublication(microphoneOn: true));
    await tester.pump();
    expect(
      find.text('${LiveCopy.activeBarTitle} · ${LiveCopy.activeBarMicOn}'),
      findsOneWidget,
    );
  });

  testWidgets('"return" opens the room, where the bar is not shown', (
    tester,
  ) async {
    await pump(tester);
    container.read(liveActiveSessionProvider.notifier).enter(active);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('live-active-return')));
    await tester.pumpAndSettle();
    expect(find.text('live room'), findsOneWidget);
    expect(find.byKey(const Key('live-active-bar')), findsNothing);
  });

  testWidgets('"leave" disconnects and the bar goes away', (tester) async {
    await pump(tester);
    container.read(liveActiveSessionProvider.notifier).enter(active);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('live-active-leave')));
    await tester.pumpAndSettle();
    // The explicit leave (and the controller's own best-effort leave when it
    // is then released — a leave is always safe to repeat).
    expect(client.disconnects, greaterThanOrEqualTo(1));
    expect(container.read(liveActiveSessionProvider), isNull);
    expect(find.byKey(const Key('live-active-bar')), findsNothing);
  });
}

class _CounterPage extends StatefulWidget {
  const _CounterPage();

  @override
  State<_CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<_CounterPage> {
  var _count = 0;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: TextButton(
        key: const Key('counter-add'),
        onPressed: () => setState(() => _count++),
        child: Text('count $_count'),
      ),
    ),
  );
}
