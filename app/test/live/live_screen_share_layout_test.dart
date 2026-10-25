import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_screen_share_view.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/features/live/widgets/live_stage.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'fake_live_media_client.dart';

/// The shared screen's layout: inline it takes the WHOLE stage (no scrim over
/// it, no info card on top of it), and from the stage it opens full screen —
/// the entire viewport in portrait or landscape, zoomable, closable back to the
/// room without touching the session. (The picture's aspect ratio is the
/// renderer's `contain`; here the track is an opaque test handle, so these
/// tests assert the space the picture is given.)
void main() {
  final session = LiveSession(
    id: 's-1',
    communityId: 'c-1',
    state: LiveSessionState.live,
    hostUserId: 'u-host',
    startedAt: DateTime.utc(2026),
    speakerCount: 1,
    me: const LiveMe(role: LiveParticipantRole.listener),
  );

  const presenter = LiveRemoteParticipant(
    identity: 'u-host',
    name: 'الشيخ',
    canSpeak: true,
    screenSharing: true,
    screenShareTrack: Object(),
  );

  late FakeLiveMediaClient client;

  Future<void> pump(
    WidgetTester tester, {
    Size screen = const Size(390, 844),
    bool sharing = true,
  }) async {
    tester.view.physicalSize = screen;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    client = FakeLiveMediaClient(initial: const LiveMediaConnected());
    addTearDown(client.dispose);
    if (sharing) {
      client.emitRemote(const LiveRemoteParticipants({'u-host': presenter}));
    }
    await tester.pumpWidget(
      ProviderScope(
        overrides: [liveMediaClientProvider.overrideWithValue(client)],
        child: MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 360,
                height: 300,
                child: LiveStage(session: session),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('no one sharing: the on-air stage, no expand control', (
    tester,
  ) async {
    await pump(tester, sharing: false);
    expect(find.byKey(const Key('live-screen-share')), findsNothing);
    expect(find.byKey(const Key('live-screen-expand')), findsNothing);
  });

  testWidgets('a shared screen fills the whole stage, with an expand control', (
    tester,
  ) async {
    await pump(tester);
    expect(
      tester.getSize(find.byType(LiveKitScreenShareView)),
      tester.getSize(find.byType(LiveStage)),
    );
    expect(find.byKey(const Key('live-screen-expand')), findsOneWidget);
  });

  for (final (label, screen) in [
    ('portrait', const Size(390, 844)),
    ('landscape', const Size(844, 390)),
  ]) {
    testWidgets('full screen uses the entire $label viewport', (tester) async {
      await pump(tester, screen: screen);
      await tester.tap(find.byKey(const Key('live-screen-expand')));
      await tester.pumpAndSettle();

      final view = find.byKey(const ValueKey('fullscreen-u-host'));
      expect(find.byKey(const Key('live-screen-fullscreen')), findsOneWidget);
      expect(tester.getSize(view), screen);
      expect(find.byKey(const Key('live-screen-close')), findsOneWidget);
    });
  }

  testWidgets('double tap on the stage opens it full screen too', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('live-screen-share')));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byKey(const Key('live-screen-share')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('live-screen-fullscreen')), findsOneWidget);
  });

  testWidgets('full screen zooms: pinch range 1–5×, double tap toggles', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('live-screen-expand')));
    await tester.pumpAndSettle();

    final zoom = tester.widget<InteractiveViewer>(
      find.byKey(const Key('live-screen-zoom')),
    );
    expect(zoom.minScale, 1);
    expect(zoom.maxScale, 5);
    double scale() => zoom.transformationController!.value.getMaxScaleOnAxis();
    expect(scale(), 1);

    Future<void> doubleTap() async {
      await tester.tap(find.byKey(const Key('live-screen-zoom')));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tap(find.byKey(const Key('live-screen-zoom')));
      await tester.pumpAndSettle();
    }

    await doubleTap();
    expect(scale(), greaterThan(1));
    await doubleTap();
    expect(scale(), 1);
  });

  testWidgets('closing full screen returns to the room — the session and '
      'media are untouched', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('live-screen-expand')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('live-screen-close')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('live-screen-fullscreen')), findsNothing);
    expect(find.byKey(const Key('live-screen-share')), findsOneWidget);
    expect(client.disconnects, 0);
  });

  testWidgets('when the share ends, full screen closes by itself', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(find.byKey(const Key('live-screen-expand')));
    await tester.pumpAndSettle();

    client.emitRemote(
      const LiveRemoteParticipants({
        'u-host': LiveRemoteParticipant(identity: 'u-host', canSpeak: true),
      }),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('live-screen-fullscreen')), findsNothing);
    expect(find.byKey(const Key('live-screen-share')), findsNothing);
    expect(client.disconnects, 0);
  });
}
