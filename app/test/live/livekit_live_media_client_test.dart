import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_live_media_client.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_room_port.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/state/live_media_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// A port the test drives in place of the LiveKit SDK: it records every call
/// and lets the test emit room signals and fail a connect. No SDK, no network.
class _FakePort implements LiveKitRoomPort {
  final _signals = StreamController<LiveKitRoomSignal>.broadcast(sync: true);
  final List<({String url, String token})> connects = [];
  int disconnects = 0;
  final List<bool> microphone = [];
  final List<({bool enabled, bool audio})> screen = [];
  bool disposed = false;
  Object? failConnect;

  void emit(LiveKitRoomSignal signal) => _signals.add(signal);

  @override
  Stream<LiveKitRoomSignal> get signals => _signals.stream;

  @override
  Future<void> connect(String url, String token) async {
    connects.add((url: url, token: token));
    if (failConnect != null) throw failConnect!;
  }

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async =>
      microphone.add(enabled);

  @override
  Future<void> setScreenShareEnabled(
    bool enabled, {
    bool captureScreenAudio = false,
  }) async => screen.add((enabled: enabled, audio: captureScreenAudio));

  @override
  Future<void> disconnect() async => disconnects += 1;

  @override
  Future<void> dispose() async {
    disposed = true;
    await _signals.close();
  }
}

LiveMediaGrant _grant({
  bool screen = false,
  String token = 'tok-xyz',
  String url = 'wss://live.test',
}) => LiveMediaGrant(
  sessionId: 's-1',
  token: token,
  url: url,
  expiresInSeconds: 120,
  expiresAt: DateTime.utc(2026),
  role: LiveParticipantRole.listener,
  microphone: true,
  screen: screen,
  screenAudio: false,
);

void main() {
  late _FakePort port;
  late LiveKitLiveMediaClient client;

  setUp(() {
    port = _FakePort();
    client = LiveKitLiveMediaClient(port: port);
  });
  tearDown(() => client.dispose());

  Future<void> connected({bool screen = false}) async {
    await client.connect(_grant(screen: screen));
    port.emit(const LiveKitConnected());
  }

  group('state & connect', () {
    test('starts idle and available', () {
      expect(client.isAvailable, isTrue);
      expect(client.state, const LiveMediaIdle());
    });

    test(
      'connect: idle → connecting → connected, grant handed to the port',
      () async {
        await client.connect(_grant());
        expect(port.connects.single, (
          url: 'wss://live.test',
          token: 'tok-xyz',
        ));
        // Connected is the room's to report — not fabricated by connect().
        expect(client.state, const LiveMediaConnecting());
        port.emit(const LiveKitConnected());
        expect(client.state, const LiveMediaConnected());
      },
    );

    test('connect failure → failed, surfaced as LiveMediaException', () async {
      port.failConnect = Exception('boom');
      await expectLater(
        client.connect(_grant()),
        throwsA(isA<LiveMediaException>()),
      );
      expect(client.state, const LiveMediaFailed());
    });

    test('an empty grant is rejected before the port is touched', () async {
      await expectLater(
        client.connect(_grant(token: '')),
        throwsA(
          isA<LiveMediaException>().having(
            (e) => e.code,
            'code',
            'invalid_grant',
          ),
        ),
      );
      expect(port.connects, isEmpty);
    });
  });

  group('signals → state', () {
    test('reconnecting then connected (a reconnect)', () async {
      await connected();
      port.emit(const LiveKitReconnecting());
      expect(client.state, const LiveMediaReconnecting());
      port.emit(const LiveKitConnected());
      expect(client.state, const LiveMediaConnected());
      // The adapter never re-connects on its own — one connect call total.
      expect(port.connects, hasLength(1));
    });

    test('a terminal disconnect carries its reason through', () async {
      await connected();
      for (final reason in LiveMediaDisconnectReason.values) {
        port.emit(LiveKitDisconnected(reason));
        expect(client.state, LiveMediaDisconnected(reason));
      }
    });
  });

  group('explicit disconnect', () {
    test('tells the port to disconnect and returns to idle', () async {
      await connected();
      await client.disconnect();
      expect(port.disconnects, 1);
      expect(client.state, const LiveMediaIdle());
    });

    test('is idempotent — repeated disconnect is safe', () async {
      await connected();
      await client.disconnect();
      await client.disconnect();
      expect(port.disconnects, 2);
      expect(client.state, const LiveMediaIdle());
    });
  });

  group('microphone', () {
    test('delegates enable/disable while connected', () async {
      await connected();
      await client.setMicrophoneEnabled(true);
      await client.setMicrophoneEnabled(false);
      expect(port.microphone, [true, false]);
    });

    test('rejected safely when not connected', () async {
      await expectLater(
        client.setMicrophoneEnabled(true),
        throwsA(
          isA<LiveMediaException>().having(
            (e) => e.code,
            'code',
            'not_connected',
          ),
        ),
      );
      expect(port.microphone, isEmpty);
    });
  });

  group('screen share', () {
    test(
      'delegates when the grant permits, never forcing screen audio',
      () async {
        await connected(screen: true);
        await client.setScreenShareEnabled(true);
        expect(port.screen.single, (enabled: true, audio: false));
      },
    );

    test(
      'is refused when the grant does not permit it — no port call',
      () async {
        await connected(screen: false);
        await expectLater(
          client.setScreenShareEnabled(true),
          throwsA(
            isA<LiveMediaException>().having(
              (e) => e.code,
              'code',
              'screen_not_permitted',
            ),
          ),
        );
        expect(port.screen, isEmpty);
      },
    );

    test('stopping is always allowed when connected', () async {
      await connected(screen: false);
      await client.setScreenShareEnabled(false);
      expect(port.screen.single, (enabled: false, audio: false));
    });
  });

  group('security & resources', () {
    test('a failure never leaks the token into the exception', () async {
      port.failConnect = Exception('connect failed for token=super-secret-jwt');
      LiveMediaException? thrown;
      try {
        await client.connect(_grant(token: 'super-secret-jwt'));
      } on LiveMediaException catch (e) {
        thrown = e;
      }
      expect(thrown, isNotNull);
      expect(thrown.toString(), isNot(contains('super-secret-jwt')));
    });

    test('dispose releases the port and the subscription', () async {
      await connected();
      await client.dispose();
      expect(port.disposed, isTrue);
    });
  });

  // §23 — the controller drives the LiveKit client without any SDK leak.
  group('LiveMediaController → LiveKitLiveMediaClient integration', () {
    test('controller.connect() joins via the repo and feeds the grant to the client', () async {
      final repo = _JoinOnlyLive(_grant(url: 'wss://r', token: 'from-join'));
      final livekit = LiveKitLiveMediaClient(port: port);
      addTearDown(livekit.dispose);
      final container = ProviderContainer(
        overrides: [
          liveRepositoryProvider.overrideWithValue(repo),
          liveMediaClientProvider.overrideWithValue(livekit),
        ],
      );
      addTearDown(container.dispose);
      final keepAlive = container.listen(liveMediaProvider('s-1'), (_, _) {});
      addTearDown(keepAlive.close);

      await container.read(liveMediaProvider('s-1').notifier).connect();
      // The controller called /join; the adapter received that grant verbatim.
      expect(repo.joinCalls, 1);
      expect(port.connects.single, (url: 'wss://r', token: 'from-join'));

      // The media plane reporting connected flows up to the controller state.
      // The adapter's `states` is a broadcast stream, so the controller sees it
      // on the next microtask — pump before asserting.
      port.emit(const LiveKitConnected());
      await pumpEventQueue();
      expect(
        container.read(liveMediaProvider('s-1')),
        const LiveMediaConnected(),
      );
    });
  });
}

/// A repository that only answers `/join` (the one call the media path makes);
/// everything else is off-limits to this flow.
class _JoinOnlyLive implements LiveRepository {
  _JoinOnlyLive(this._grant);
  final LiveMediaGrant _grant;
  int joinCalls = 0;

  @override
  Future<LiveMediaGrant> join(String sessionId) async {
    joinCalls += 1;
    return _grant;
  }

  @override
  Future<LiveSession?> currentSession(String communityId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> getSession(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) => throw UnimplementedError();
  @override
  Future<LiveSession> endSession(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  }) => throw UnimplementedError();
  @override
  Future<bool> resetRoom(String sessionId) => throw UnimplementedError();
  @override
  Future<LiveSession> claimPresenter(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> stopPresenter(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> grantPresenter(String sessionId, String userId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> revokePresenter(String sessionId, String userId) =>
      throw UnimplementedError();
}
