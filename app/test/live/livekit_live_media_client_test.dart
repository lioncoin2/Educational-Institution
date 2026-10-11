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
  Object? failDisconnect;
  Object? failScreen;

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
  }) async {
    screen.add((enabled: enabled, audio: captureScreenAudio));
    if (failScreen != null) throw failScreen!;
  }

  @override
  Future<void> disconnect() async {
    disconnects += 1;
    if (failDisconnect != null) throw failDisconnect!;
  }

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

    test('is best-effort: a port teardown error neither throws nor strands state', () async {
      await connected();
      port.failDisconnect = Exception('teardown boom');
      // The seam contract says disconnect is always safe to call; a failed room
      // teardown must not surface to the caller (the controller does not catch)
      // and must still land on idle. `expectLater(..., completes)` fails if it throws.
      await expectLater(client.disconnect(), completes);
      expect(port.disconnects, 1);
      expect(client.state, const LiveMediaIdle());
    });

    test('stays best-effort even for a non-Exception Error from the port', () async {
      await connected();
      // The port now rethrows the FIRST teardown failure once every resource
      // has had its cleanup attempt, and that first failure may be an Error (a
      // programming bug in teardown), not just an Exception. The client's leave
      // must stay safe for any throw and still land on idle.
      port.failDisconnect = StateError('teardown bug');
      await expectLater(client.disconnect(), completes);
      expect(port.disconnects, 1);
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

  // D3 — live capability synchronization: a presenter grant/revoke that reaches
  // a CONNECTED client as the SDK's ParticipantPermissionsUpdatedEvent (relayed
  // here as LiveKitCapabilities) updates the authorization without a reconnect.
  // These are deterministic fakes — they prove the client's logic, NOT real
  // LiveKit interoperability (the real path is the Live E2E).
  group('live capability sync (D3)', () {
    test('a grant received while connected authorizes screen sharing — no reconnect', () async {
      await connected(screen: false); // joined unauthorized
      expect(client.screenAuthorized, isFalse);
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

      port.emit(const LiveKitCapabilities(canPublishScreen: true));
      expect(client.screenAuthorized, isTrue);
      await client.setScreenShareEnabled(true); // now authorized → forwarded
      expect(port.screen.single, (enabled: true, audio: false));
      expect(port.connects, hasLength(1)); // never reconnected
    });

    test('a grant never auto-starts capture — only the authority changes', () async {
      await connected(screen: false);
      port.emit(const LiveKitCapabilities(canPublishScreen: true));
      expect(client.screenAuthorized, isTrue);
      expect(port.screen, isEmpty); // capture still needs explicit user intent
    });

    test('a revoke stops active capture and re-blocks sharing', () async {
      await connected(screen: true);
      await client.setScreenShareEnabled(true);
      expect(port.screen, [(enabled: true, audio: false)]);

      port.emit(const LiveKitCapabilities(canPublishScreen: false)); // revoked
      await pumpEventQueue(); // the best-effort stop runs on a microtask
      expect(client.screenAuthorized, isFalse);
      // The server authority signal — not the UI — stopped the capture.
      expect(port.screen.last, (enabled: false, audio: false));
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
    });

    test('duplicate and no-change updates are idempotent — exactly one stop', () async {
      await connected(screen: true);
      await client.setScreenShareEnabled(true);
      port.screen.clear();

      port.emit(const LiveKitCapabilities(canPublishScreen: true)); // no change
      port.emit(const LiveKitCapabilities(canPublishScreen: false)); // revoke
      port.emit(const LiveKitCapabilities(canPublishScreen: false)); // duplicate
      await pumpEventQueue();
      expect(port.screen, [(enabled: false, audio: false)]); // one stop only
      expect(client.screenAuthorized, isFalse);
    });

    test('out-of-order updates settle on the latest value', () async {
      await connected(screen: false);
      port.emit(const LiveKitCapabilities(canPublishScreen: true));
      port.emit(const LiveKitCapabilities(canPublishScreen: false));
      port.emit(const LiveKitCapabilities(canPublishScreen: true)); // latest wins
      await pumpEventQueue();
      expect(client.screenAuthorized, isTrue);
      await client.setScreenShareEnabled(true);
      expect(port.screen.last, (enabled: true, audio: false));
    });

    test('a server/SDK refusal despite authorization is surfaced, not faked', () async {
      await connected(screen: false);
      port.emit(const LiveKitCapabilities(canPublishScreen: true));
      // Authorized locally, but the SDK/server refuses the actual publish.
      port.failScreen = Exception('capture refused for token=super-secret');
      LiveMediaException? thrown;
      try {
        await client.setScreenShareEnabled(true);
      } on LiveMediaException catch (e) {
        thrown = e;
      }
      expect(thrown, isNotNull); // never a pretended success
      expect(thrown.toString(), isNot(contains('super-secret'))); // no leak
    });

    test('authorization is dropped on disconnect', () async {
      await connected(screen: true);
      expect(client.screenAuthorized, isTrue);
      await client.disconnect();
      expect(client.screenAuthorized, isFalse);
    });

    test('a fresh connect with a new grant resets authority (session change)', () async {
      await connected(screen: true);
      expect(client.screenAuthorized, isTrue);
      await client.disconnect();
      // A new session / reconnect brings a NEW grant; a stale "true" never
      // carries over.
      await client.connect(_grant(screen: false));
      expect(client.screenAuthorized, isFalse);
    });

    test('the microphone is unaffected by capability changes', () async {
      await connected(screen: false);
      port.emit(const LiveKitCapabilities(canPublishScreen: true));
      await client.setMicrophoneEnabled(true);
      await client.setMicrophoneEnabled(false);
      expect(port.microphone, [true, false]);
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
