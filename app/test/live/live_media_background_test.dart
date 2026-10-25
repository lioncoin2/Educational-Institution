import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/features/live/state/live_media_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'fake_live_media_client.dart';

/// On a native platform the OS stops (or forbids) background microphone
/// capture, so leaving the foreground turns a LIVE mic off — once, through the
/// same seam command as the mic button — and the viewer turns it back on
/// explicitly. The web keeps its behavior, and nothing outlives the controller.
void main() {
  ({FakeLiveMediaClient client, ProviderContainer container}) start({
    required bool muteInBackground,
    LiveMediaState state = const LiveMediaConnected(),
    bool micOn = true,
  }) {
    final client = FakeLiveMediaClient(initial: state);
    if (micOn) {
      client.emitPublication(const LiveMediaPublication(microphoneOn: true));
    }
    final container = ProviderContainer(
      overrides: [
        liveMediaClientProvider.overrideWithValue(client),
        liveMediaMuteInBackgroundProvider.overrideWithValue(muteInBackground),
      ],
    );
    addTearDown(client.dispose);
    addTearDown(container.dispose);
    // Keep the autoDispose controller alive, as the live screen does.
    final sub = container.listen(liveMediaProvider('s-1'), (_, _) {});
    addTearDown(sub.close);
    return (client: client, container: container);
  }

  Future<void> goToBackground(WidgetTester tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
  }

  tearDown(() {
    // Back to the foreground for the next test.
    TestWidgetsFlutterBinding.instance.handleAppLifecycleStateChanged(
      AppLifecycleState.resumed,
    );
  });

  testWidgets('native: a live mic is turned off when the app goes to the '
      'background', (tester) async {
    final h = start(muteInBackground: true);
    await goToBackground(tester);
    expect(h.client.microphoneCommands, [false]);
  });

  testWidgets('native: nothing is commanded when the mic is already off', (
    tester,
  ) async {
    final h = start(muteInBackground: true, micOn: false);
    await goToBackground(tester);
    expect(h.client.microphoneCommands, isEmpty);
  });

  testWidgets('native: nothing is commanded while not connected', (
    tester,
  ) async {
    final h = start(muteInBackground: true, state: const LiveMediaIdle());
    await goToBackground(tester);
    expect(h.client.microphoneCommands, isEmpty);
  });

  testWidgets('web: a hidden tab keeps its mic (behavior unchanged)', (
    tester,
  ) async {
    final h = start(muteInBackground: false);
    await goToBackground(tester);
    expect(h.client.microphoneCommands, isEmpty);
  });

  testWidgets('a failed mute is swallowed, and no listener outlives the '
      'controller', (tester) async {
    final h = start(muteInBackground: true);
    h.client.failNext = const LiveMediaException('media_error', 'gone');
    await goToBackground(tester);
    expect(h.client.microphoneCommands, [false]); // attempted, error swallowed
    expect(tester.takeException(), isNull);

    // Dispose the controller (the live screen closed), then background again.
    h.container.dispose();
    TestWidgetsFlutterBinding.instance.handleAppLifecycleStateChanged(
      AppLifecycleState.resumed,
    );
    await goToBackground(tester);
    expect(h.client.microphoneCommands, [false]); // no second command
  });
}
