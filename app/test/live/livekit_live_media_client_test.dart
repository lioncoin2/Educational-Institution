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
  Object? failMicrophone;
  /// When set, [setMicrophoneEnabled] awaits this before returning — so a test
  /// can leave/disconnect while a publish command is still in flight.
  Completer<void>? gateMic;
  /// When set, a screen-share START (enabled: true) awaits this before returning
  /// — so a test can revoke/stop while a screen publish is still in flight. The
  /// stop path (enabled: false) is never gated, so a revoke's quiet-stop runs.
  Completer<void>? gateScreenStart;

  void emit(LiveKitRoomSignal signal) => _signals.add(signal);

  @override
  Stream<LiveKitRoomSignal> get signals => _signals.stream;

  @override
  Future<void> connect(String url, String token) async {
    connects.add((url: url, token: token));
    if (failConnect != null) throw failConnect!;
  }

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    microphone.add(enabled);
    if (gateMic != null) await gateMic!.future;
    if (failMicrophone != null) throw failMicrophone!;
  }

  @override
  Future<void> setScreenShareEnabled(
    bool enabled, {
    bool captureScreenAudio = false,
  }) async {
    screen.add((enabled: enabled, audio: captureScreenAudio));
    if (enabled && gateScreenStart != null) await gateScreenStart!.future;
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

    // Sprint 15 — a publish FAILURE (the SDK/device refuses) is surfaced as a
    // sanitized media_error, not swallowed into a false "on": the publication
    // stays off because it is driven by the SDK's own track signal, never by the
    // command returning. Symmetric to the screen-share refusal path. The token
    // never reaches the exception (the port holds it).
    test('a microphone publish failure surfaces media_error; publication stays off', () async {
      await connected();
      port.failMicrophone = Exception('mic publish refused for token=super-secret');
      final seen = <LiveMediaPublication>[];
      final sub = client.publications.listen(seen.add);

      LiveMediaException? thrown;
      try {
        await client.setMicrophoneEnabled(true);
      } on LiveMediaException catch (e) {
        thrown = e;
      }
      await pumpEventQueue();

      expect(thrown, isNotNull);
      expect(thrown!.code, 'media_error');
      expect(thrown.toString(), isNot(contains('super-secret')));
      // No LocalTrackPublished signal ever came, so the publication is unchanged.
      expect(client.publication.microphoneOn, isFalse);
      expect(seen, isEmpty);
      await sub.cancel();
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

  // Sprint 10 — the publication snapshot/stream is the SDK-reconciled truth
  // (authorization + the actually published tracks), fed by the port's
  // LiveKitCapabilities and LiveKitLocalTracks signals. Deterministic fakes.
  group('publication reconciliation (Sprint 10)', () {
    test('connect seeds the publication from the grant authorization', () async {
      await connected(screen: true);
      expect(
        client.publication,
        const LiveMediaPublication(screenAuthorized: true),
      );
    });

    test('local-track signals reconcile the mic/screen on-state', () async {
      await connected(screen: true);
      port.emit(
        const LiveKitLocalTracks(microphoneOn: true, screenShareOn: false),
      );
      expect(client.publication.microphoneOn, isTrue);
      expect(client.publication.screenShareOn, isFalse);

      port.emit(
        const LiveKitLocalTracks(microphoneOn: false, screenShareOn: true),
      );
      expect(client.publication.microphoneOn, isFalse);
      expect(client.publication.screenShareOn, isTrue);
    });

    test('the capability signal reconciles the authorization', () async {
      await connected(screen: false);
      expect(client.publication.screenAuthorized, isFalse);
      port.emit(const LiveKitCapabilities(canPublishScreen: true));
      expect(client.publication.screenAuthorized, isTrue);
      expect(client.screenAuthorized, isTrue); // the getter agrees
    });

    test('publications stream emits each real change, in order', () async {
      await connected(screen: false);
      final seen = <LiveMediaPublication>[];
      final sub = client.publications.listen(seen.add);

      port.emit(
        const LiveKitLocalTracks(microphoneOn: true, screenShareOn: false),
      );
      port.emit(const LiveKitCapabilities(canPublishScreen: true));
      await pumpEventQueue();

      expect(seen, [
        const LiveMediaPublication(microphoneOn: true),
        const LiveMediaPublication(microphoneOn: true, screenAuthorized: true),
      ]);
      await sub.cancel();
    });

    test('a no-change signal does not churn the stream', () async {
      await connected(screen: false);
      final seen = <LiveMediaPublication>[];
      final sub = client.publications.listen(seen.add);
      port.emit(
        const LiveKitLocalTracks(microphoneOn: false, screenShareOn: false),
      );
      await pumpEventQueue();
      expect(seen, isEmpty); // identical to the current snapshot → no emit
      await sub.cancel();
    });

    test('disconnect resets the publication to empty', () async {
      await connected(screen: true);
      port.emit(
        const LiveKitLocalTracks(microphoneOn: true, screenShareOn: true),
      );
      expect(
        client.publication,
        const LiveMediaPublication(
          screenAuthorized: true,
          microphoneOn: true,
          screenShareOn: true,
        ),
      );
      await client.disconnect();
      expect(client.publication, const LiveMediaPublication());
    });
  });

  // Sprint 11 — remote participants reconciled from the port's
  // LiveKitRemoteParticipants signal (itself read from the room snapshot).
  // Deterministic fakes — NOT a real second participant.
  group('remote participant reconciliation (Sprint 11)', () {
    LiveRemoteParticipants remoteSet(Map<String, LiveRemoteParticipant> m) =>
        LiveRemoteParticipants(Map.unmodifiable(m));

    test('a remote signal updates the remote set', () async {
      await connected(screen: false);
      expect(client.remoteParticipants.length, 0);

      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-1': const LiveRemoteParticipant(
              identity: 'u-1',
              audio: LiveRemoteAudio.live,
            ),
          }),
        ),
      );
      expect(client.remoteParticipants.length, 1);
      expect(client.remoteParticipants['u-1']?.audio, LiveRemoteAudio.live);
    });

    test('the stream emits each real change; a no-change is not churned', () async {
      await connected(screen: false);
      final seen = <LiveRemoteParticipants>[];
      final sub = client.remoteParticipantChanges.listen(seen.add);

      final a = remoteSet({
        'u-1': const LiveRemoteParticipant(
          identity: 'u-1',
          audio: LiveRemoteAudio.muted,
        ),
      });
      port.emit(LiveKitRemoteParticipants(a));
      port.emit(LiveKitRemoteParticipants(a)); // identical snapshot → no churn
      await pumpEventQueue();

      expect(seen, [a]);
      await sub.cancel();
    });

    test('a departed participant is dropped by the reconciled snapshot', () async {
      await connected(screen: false);
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-1': const LiveRemoteParticipant(identity: 'u-1'),
            'u-2': const LiveRemoteParticipant(
              identity: 'u-2',
              screenSharing: true,
            ),
          }),
        ),
      );
      expect(client.remoteParticipants.length, 2);

      // u-1 left: the next snapshot simply omits them — never a ghost.
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-2': const LiveRemoteParticipant(
              identity: 'u-2',
              screenSharing: true,
            ),
          }),
        ),
      );
      expect(client.remoteParticipants.length, 1);
      expect(client.remoteParticipants['u-1'], isNull);
      expect(client.remoteParticipants['u-2']?.screenSharing, isTrue);
    });

    // Sprint 14 — the deterministic complement to the three-client E2E: with
    // THREE remote participants, one departing removes ONLY that one and leaves
    // the others' media state intact (reconcile-from-snapshot, so no ghost and
    // no collateral change).
    test('three participants: one departs → only that one removed, others intact', () async {
      await connected(screen: false);
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-1': const LiveRemoteParticipant(identity: 'u-1', audio: LiveRemoteAudio.live),
            'u-2': const LiveRemoteParticipant(identity: 'u-2', audio: LiveRemoteAudio.muted),
            'u-3': const LiveRemoteParticipant(identity: 'u-3', screenSharing: true),
          }),
        ),
      );
      expect(client.remoteParticipants.length, 3);

      // u-2 leaves: the next authoritative snapshot simply omits it; u-1's live
      // audio and u-3's screen share are untouched.
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-1': const LiveRemoteParticipant(identity: 'u-1', audio: LiveRemoteAudio.live),
            'u-3': const LiveRemoteParticipant(identity: 'u-3', screenSharing: true),
          }),
        ),
      );
      expect(client.remoteParticipants.length, 2);
      expect(client.remoteParticipants['u-2'], isNull);
      expect(client.remoteParticipants['u-1']?.audio, LiveRemoteAudio.live);
      expect(client.remoteParticipants['u-3']?.screenSharing, isTrue);
    });

    test('disconnect clears the remote set', () async {
      await connected(screen: false);
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({'u-1': const LiveRemoteParticipant(identity: 'u-1')}),
        ),
      );
      expect(client.remoteParticipants.length, 1);
      await client.disconnect();
      expect(client.remoteParticipants, LiveRemoteParticipants.empty);
    });

    test('a fresh connect starts with an empty remote set (session change)', () async {
      await connected(screen: false);
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({'u-1': const LiveRemoteParticipant(identity: 'u-1')}),
        ),
      );
      await client.disconnect();
      await client.connect(_grant(screen: false));
      expect(client.remoteParticipants, LiveRemoteParticipants.empty);
    });
  });

  // Sprint 15 — a TERMINAL media drop (the SDK's LiveKitDisconnected) must leave
  // NO stale media state. An explicit disconnect() already clears, but a
  // server-/SDK-driven terminal drop (a room reset deleting the room, a kick, a
  // duplicate identity) was leaving the remote set and the publication stale
  // until some later connect/disconnect — a stale roster chip / publication
  // indicator outliving its connection. A transient reconnecting must NOT clear.
  group('terminal disconnect clears media state (Sprint 15)', () {
    LiveRemoteParticipants remoteSet(Map<String, LiveRemoteParticipant> m) =>
        LiveRemoteParticipants(Map.unmodifiable(m));

    test('a terminal drop clears the remote set, the publication and authorization', () async {
      await connected(screen: true);
      port.emit(const LiveKitLocalTracks(microphoneOn: true, screenShareOn: true));
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-1': const LiveRemoteParticipant(identity: 'u-1', audio: LiveRemoteAudio.live),
          }),
        ),
      );
      expect(client.remoteParticipants.length, 1);
      expect(client.publication.microphoneOn, isTrue);
      expect(client.screenAuthorized, isTrue);

      // The room drops (e.g. a reset deleted it). No explicit disconnect() ran,
      // yet the media state must still converge to clean — no stale roster, no
      // stale publication, authorization withdrawn.
      port.emit(const LiveKitDisconnected(LiveMediaDisconnectReason.roomDeleted));
      expect(
        client.state,
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
      expect(client.remoteParticipants, LiveRemoteParticipants.empty);
      expect(client.publication, const LiveMediaPublication());
      expect(client.screenAuthorized, isFalse);
    });

    test('a transient reconnecting preserves the remote set and the publication', () async {
      await connected(screen: true);
      port.emit(const LiveKitLocalTracks(microphoneOn: true, screenShareOn: false));
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({'u-1': const LiveRemoteParticipant(identity: 'u-1')}),
        ),
      );

      // A blip is NOT a terminal drop: it returns on reconnected, so the media
      // state is deliberately preserved across it.
      port.emit(const LiveKitReconnecting());
      expect(client.state, const LiveMediaReconnecting());
      expect(client.remoteParticipants.length, 1);
      expect(client.publication.microphoneOn, isTrue);
    });
  });

  // Sprint 16 — a reconcile signal (capability / local tracks / remote
  // participants) that arrives when there is NO live connection — a late/queued
  // event delivered around a teardown, since the port's broadcast is async and
  // the client's subscription outlives disconnect() — must be IGNORED, so it
  // cannot resurrect stale media state after a terminal drop or an explicit
  // disconnect(). During a transient reconnecting it IS still applied, which is
  // how the client converges to the current room after the blip.
  group('stale reconcile signals without a live connection are ignored (Sprint 16)', () {
    LiveRemoteParticipants remoteSet(Map<String, LiveRemoteParticipant> m) =>
        LiveRemoteParticipants(Map.unmodifiable(m));

    test('a remote signal after an explicit disconnect is ignored', () async {
      await connected();
      await client.disconnect();
      expect(client.state, const LiveMediaIdle());
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({'u-1': const LiveRemoteParticipant(identity: 'u-1')}),
        ),
      );
      expect(client.remoteParticipants, LiveRemoteParticipants.empty);
    });

    test('a local-tracks signal after disconnect does not resurrect the publication', () async {
      await connected(screen: true);
      await client.disconnect();
      port.emit(const LiveKitLocalTracks(microphoneOn: true, screenShareOn: true));
      expect(client.publication, const LiveMediaPublication());
    });

    test('a capability signal after disconnect does not re-authorize screen share', () async {
      await connected(screen: false);
      await client.disconnect();
      port.emit(const LiveKitCapabilities(canPublishScreen: true));
      expect(client.screenAuthorized, isFalse);
      expect(client.publication.screenAuthorized, isFalse);
    });

    test('a late remote signal queued around a TERMINAL drop cannot bring a peer back', () async {
      await connected();
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({'u-1': const LiveRemoteParticipant(identity: 'u-1')}),
        ),
      );
      expect(client.remoteParticipants.length, 1);
      // The terminal drop clears (Sprint 15) ...
      port.emit(const LiveKitDisconnected(LiveMediaDisconnectReason.roomDeleted));
      expect(client.remoteParticipants, LiveRemoteParticipants.empty);
      // ... and a stale event delivered just after it cannot resurrect the peer.
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({'u-1': const LiveRemoteParticipant(identity: 'u-1')}),
        ),
      );
      expect(client.remoteParticipants, LiveRemoteParticipants.empty);
    });

    test('a reconcile signal DURING reconnecting IS applied (converges across a blip)', () async {
      await connected();
      port.emit(const LiveKitReconnecting());
      expect(client.state, const LiveMediaReconnecting());
      // Reconnecting is a live state: reconciling here is how the client
      // converges to the current room after the transient interruption.
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-1': const LiveRemoteParticipant(identity: 'u-1', audio: LiveRemoteAudio.live),
          }),
        ),
      );
      expect(client.remoteParticipants['u-1']?.audio, LiveRemoteAudio.live);
    });
  });

  // Sprint 17 — production-readiness lifecycle. REPEATED join→media→leave→join
  // cycles must never leak a previous session's state into the next, and leaving
  // while a publish command is still in flight must not resurrect it. (No looped
  // multi-cycle test existed before — prior coverage was single session-change.)
  group('repeated-session & pending-op lifecycle (Sprint 17)', () {
    test('repeated connect → media → disconnect cycles never leak between sessions', () async {
      for (var i = 0; i < 5; i++) {
        final authorized = i.isEven; // vary authority so a leak would show
        await client.connect(_grant(screen: authorized));
        port.emit(const LiveKitConnected());
        expect(client.state, const LiveMediaConnected());
        // A fresh session starts CLEAN — no remote/publication from the prior cycle.
        expect(
          client.remoteParticipants,
          LiveRemoteParticipants.empty,
          reason: 'cycle $i started with a stale remote set',
        );
        expect(
          client.publication,
          LiveMediaPublication(screenAuthorized: authorized),
          reason: 'cycle $i started with a stale publication',
        );

        // Exercise this session's media (distinct per cycle).
        await client.setMicrophoneEnabled(true);
        port.emit(const LiveKitLocalTracks(microphoneOn: true, screenShareOn: false));
        port.emit(
          LiveKitRemoteParticipants(
            LiveRemoteParticipants(
              Map.unmodifiable({
                'u-$i': LiveRemoteParticipant(identity: 'u-$i', audio: LiveRemoteAudio.live),
              }),
            ),
          ),
        );
        expect(client.publication.microphoneOn, isTrue);
        expect(client.remoteParticipants.length, 1);
        expect(client.remoteParticipants['u-$i'], isNotNull);

        // Leave — everything clears before the next cycle.
        await client.disconnect();
        expect(client.state, const LiveMediaIdle());
        expect(client.remoteParticipants, LiveRemoteParticipants.empty);
        expect(client.publication, const LiveMediaPublication());
      }
    });

    test('leaving while a mic publish is in flight does not resurrect it', () async {
      await connected();
      port.gateMic = Completer<void>();
      final pending = client.setMicrophoneEnabled(true); // hangs on the gate
      await client.disconnect(); // the viewer leaves while the publish is pending
      expect(client.state, const LiveMediaIdle());
      expect(client.publication, const LiveMediaPublication());

      port.gateMic!.complete(); // the publish command now completes, post-leave
      await pending;
      // A late command completion is signal-free and cannot resurrect state.
      expect(client.publication, const LiveMediaPublication());
      expect(client.state, const LiveMediaIdle());
    });
  });

  // Sprint 18 — two race orderings not previously covered: a screen-share
  // publish START racing a permission REVOKE, and a TERMINAL drop arriving WHILE
  // reconnecting. Both assert the final state reflects the authoritative truth,
  // never a stale/false-active one.
  group('publish-vs-revoke and terminal-while-reconnecting races (Sprint 18)', () {
    LiveRemoteParticipants remoteSet(Map<String, LiveRemoteParticipant> m) =>
        LiveRemoteParticipants(Map.unmodifiable(m));

    test('a revoke while a screen publish is STARTING leaves it not-active', () async {
      await connected(screen: true);
      port.gateScreenStart = Completer<void>();
      final pending = client.setScreenShareEnabled(true); // hangs on the start gate

      // Authorization is revoked mid-start (the server pushes canPublishScreen
      // false); this drops authority and best-effort stops capture.
      port.emit(const LiveKitCapabilities(canPublishScreen: false));
      expect(client.screenAuthorized, isFalse);

      port.gateScreenStart!.complete(); // the start command now returns, post-revoke
      await pending;
      // The late start success cannot leave screen share falsely active — the
      // publication is signal-driven and no "on" local-track signal arrived.
      expect(client.screenAuthorized, isFalse);
      expect(client.publication.screenAuthorized, isFalse);
      expect(client.publication.screenShareOn, isFalse);
    });

    test('a terminal drop WHILE reconnecting clears state and goes disconnected', () async {
      await connected(screen: true);
      port.emit(const LiveKitLocalTracks(microphoneOn: true, screenShareOn: false));
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-1': const LiveRemoteParticipant(identity: 'u-1', audio: LiveRemoteAudio.live),
          }),
        ),
      );

      // A transient reconnect begins — state preserved across the blip.
      port.emit(const LiveKitReconnecting());
      expect(client.state, const LiveMediaReconnecting());
      expect(client.remoteParticipants.length, 1);

      // ...but the reconnect ends terminally (the room is gone). The media state
      // must converge to clean + disconnected, not stay stuck in reconnecting.
      port.emit(const LiveKitDisconnected(LiveMediaDisconnectReason.roomDeleted));
      expect(
        client.state,
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
      expect(client.remoteParticipants, LiveRemoteParticipants.empty);
      expect(client.publication, const LiveMediaPublication());
      expect(client.screenAuthorized, isFalse);
    });
  });

  // Sprint 13 — the LOCAL publication state and the REMOTE participant state are
  // independent facts, carried by different signals. A signal about our OWN
  // tracks must never alter the remote set, and a signal about REMOTE
  // participants must never alter our own publication. (The real two-client
  // screen-share E2E proves the same separation against a live server; this is
  // the fast deterministic guard for it.)
  group('local/remote screen-share state separation (Sprint 13)', () {
    LiveRemoteParticipants remoteSet(Map<String, LiveRemoteParticipant> m) =>
        LiveRemoteParticipants(Map.unmodifiable(m));

    test('a local screen-share signal never touches the remote set', () async {
      await connected(screen: true);
      port.emit(
        const LiveKitLocalTracks(microphoneOn: false, screenShareOn: true),
      );
      expect(client.publication.screenShareOn, isTrue);
      // Our own share is a LOCAL fact — the remote set stays empty.
      expect(client.remoteParticipants, LiveRemoteParticipants.empty);
    });

    test('a remote screen-share signal never touches our own publication', () async {
      await connected(screen: true);
      port.emit(
        LiveKitRemoteParticipants(
          remoteSet({
            'u-remote': const LiveRemoteParticipant(
              identity: 'u-remote',
              screenSharing: true,
            ),
          }),
        ),
      );
      expect(client.remoteParticipants['u-remote']?.screenSharing, isTrue);
      // A remote participant sharing is NOT us sharing.
      expect(client.publication.screenShareOn, isFalse);
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
  Future<LiveSession> start(String communityId) => throw UnimplementedError();

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
  @override
  Future<LiveHand> raiseHand(String sessionId) => throw UnimplementedError();
  @override
  Future<LiveHand?> lowerHand(String sessionId) => throw UnimplementedError();
  @override
  Future<LiveHand> grantFloor(String requestId) => throw UnimplementedError();
  @override
  Future<LiveHand> declineHand(String requestId) => throw UnimplementedError();
  @override
  Future<LiveHand> revokeFloor(String requestId) => throw UnimplementedError();
}
