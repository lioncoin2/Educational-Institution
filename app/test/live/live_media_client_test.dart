import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';

import 'fake_live_media_client.dart';

LiveMediaGrant _grant() => LiveMediaGrant(
  sessionId: 's-1',
  token: 'eyJ.secret.sig',
  url: 'wss://x',
  expiresInSeconds: 120,
  expiresAt: DateTime.utc(2026),
  role: LiveParticipantRole.listener,
  microphone: false,
  screen: false,
  screenAudio: false,
);

void main() {
  group('LiveMediaState', () {
    test('the stateless states are const-canonical (value-equal)', () {
      expect(const LiveMediaUnavailable(), const LiveMediaUnavailable());
      expect(const LiveMediaIdle(), const LiveMediaIdle());
      expect(const LiveMediaConnecting(), const LiveMediaConnecting());
      expect(const LiveMediaConnected(), const LiveMediaConnected());
      expect(const LiveMediaReconnecting(), const LiveMediaReconnecting());
      expect(const LiveMediaFailed(), const LiveMediaFailed());
      expect(const LiveMediaIdle(), isNot(const LiveMediaConnected()));
    });

    test('disconnected carries and compares its reason', () {
      expect(
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
      expect(
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
        isNot(
          const LiveMediaDisconnected(
            LiveMediaDisconnectReason.participantRemoved,
          ),
        ),
      );
    });

    test('names exactly the four app-owned disconnect reasons', () {
      expect(LiveMediaDisconnectReason.values, [
        LiveMediaDisconnectReason.duplicateIdentity,
        LiveMediaDisconnectReason.roomDeleted,
        LiveMediaDisconnectReason.participantRemoved,
        LiveMediaDisconnectReason.other,
      ]);
    });

    test('the state is sealed — a switch is exhaustive', () {
      String name(LiveMediaState s) => switch (s) {
        LiveMediaUnavailable() => 'unavailable',
        LiveMediaIdle() => 'idle',
        LiveMediaConnecting() => 'connecting',
        LiveMediaConnected() => 'connected',
        LiveMediaReconnecting() => 'reconnecting',
        LiveMediaDisconnected() => 'disconnected',
        LiveMediaFailed() => 'failed',
      };
      expect(name(const LiveMediaConnected()), 'connected');
      expect(
        name(const LiveMediaDisconnected(LiveMediaDisconnectReason.other)),
        'disconnected',
      );
    });
  });

  group('UnavailableLiveMediaClient', () {
    const client = UnavailableLiveMediaClient();

    test('is not available and reports the unavailable state', () async {
      expect(client.isAvailable, isFalse);
      expect(client.state, const LiveMediaUnavailable());
      expect(await client.states.first, const LiveMediaUnavailable());
    });

    test(
      'connect and the publish controls fail explicitly — no pretence',
      () async {
        await expectLater(
          client.connect(_grant()),
          throwsA(isA<LiveMediaException>()),
        );
        await expectLater(
          client.setMicrophoneEnabled(true),
          throwsA(isA<LiveMediaException>()),
        );
        await expectLater(
          client.setScreenShareEnabled(true),
          throwsA(isA<LiveMediaException>()),
        );
      },
    );

    test('disconnect is a safe no-op', () async {
      await expectLater(client.disconnect(), completes);
    });
  });

  group('FakeLiveMediaClient', () {
    test('records connect with the grant, and the publish toggles', () async {
      final client = FakeLiveMediaClient();
      addTearDown(client.dispose);

      final grant = _grant();
      await client.connect(grant);
      await client.setMicrophoneEnabled(true);
      await client.setScreenShareEnabled(false);
      await client.disconnect();

      expect(client.connects.single, same(grant));
      expect(client.microphoneCommands, [true]);
      expect(client.screenShareCommands, [false]);
      expect(client.disconnects, 1);
    });

    test('its state stream emits what the test drives', () async {
      final client = FakeLiveMediaClient();
      addTearDown(client.dispose);

      final seen = <LiveMediaState>[];
      final sub = client.states.listen(seen.add);
      client.emit(const LiveMediaConnecting());
      client.emit(const LiveMediaConnected());
      client.emit(
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
      await sub.cancel();

      expect(seen, [
        const LiveMediaConnecting(),
        const LiveMediaConnected(),
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      ]);
      expect(client.state, isA<LiveMediaDisconnected>());
    });

    test('can inject a failure on the next command', () async {
      final client = FakeLiveMediaClient();
      addTearDown(client.dispose);

      client.failNext = const LiveMediaException('boom', 'nope');
      await expectLater(
        client.connect(_grant()),
        throwsA(isA<LiveMediaException>()),
      );
      // The failure is one-shot: the next command succeeds.
      await expectLater(client.connect(_grant()), completes);
    });
  });
}
