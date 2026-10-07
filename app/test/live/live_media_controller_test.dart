import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/state/live_media_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'fake_live_media_client.dart';

LiveMediaGrant _grant(String sessionId) => LiveMediaGrant(
  sessionId: sessionId,
  token: 'token-for-$sessionId',
  url: 'wss://live.test',
  expiresInSeconds: 120,
  expiresAt: DateTime.utc(2026),
  role: LiveParticipantRole.listener,
  microphone: false,
  screen: false,
  screenAudio: false,
);

LiveSession _session(String id, {required bool live}) => LiveSession(
  id: id,
  communityId: 'c-1',
  state: live ? LiveSessionState.live : LiveSessionState.ended,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 0,
  me: const LiveMe(),
  origin: DataOrigin.records,
);

/// A repository the test drives: it records how often `/join` and `getSession`
/// were called, can hold a join in flight (for the stale-result race) and can
/// make either fail. Everything else is off-limits to the media controller.
class _FakeLive implements LiveRepository {
  int joinCalls = 0;
  int getSessionCalls = 0;
  Completer<void>? holdJoin;
  Object? joinError;
  LiveSession Function(String id)? sessionAnswer;
  Object? getSessionError;

  @override
  Future<LiveMediaGrant> join(String sessionId) async {
    joinCalls += 1;
    if (holdJoin != null) await holdJoin!.future;
    if (joinError != null) throw joinError!;
    return _grant(sessionId);
  }

  @override
  Future<LiveSession> getSession(String sessionId) async {
    getSessionCalls += 1;
    if (getSessionError != null) throw getSessionError!;
    return (sessionAnswer ?? (id) => _session(id, live: true))(sessionId);
  }

  // The media controller must touch nothing else.
  @override
  Future<LiveSession?> currentSession(String communityId) =>
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

void main() {
  late _FakeLive repo;
  late FakeLiveMediaClient client;

  setUp(() {
    repo = _FakeLive();
    client = FakeLiveMediaClient();
  });

  ProviderContainer boot({LiveMediaClient? media}) {
    final c = ProviderContainer(
      overrides: [
        liveRepositoryProvider.overrideWithValue(repo),
        liveMediaClientProvider.overrideWithValue(media ?? client),
      ],
    );
    addTearDown(client.dispose);
    addTearDown(c.dispose);
    return c;
  }

  LiveMediaController ctrl(ProviderContainer c, [String id = 's-1']) {
    final keepAlive = c.listen(liveMediaProvider(id), (_, _) {});
    addTearDown(keepAlive.close);
    // Touch the provider so build() runs and subscribes.
    c.read(liveMediaProvider(id));
    return c.read(liveMediaProvider(id).notifier);
  }

  LiveMediaState stateOf(ProviderContainer c, [String id = 's-1']) =>
      c.read(liveMediaProvider(id));

  Future<void> settle() => pumpEventQueue();

  group('construction', () {
    test('starts at the client state and joins nothing', () {
      final c = boot();
      final controller = ctrl(c);
      expect(controller.sessionId, 's-1');
      expect(stateOf(c), const LiveMediaIdle()); // the fake's initial state
      expect(repo.joinCalls, 0); // never joins on construction
    });

    test('a different session is a different controller instance', () {
      final c = boot();
      expect(
        identical(
          c.read(liveMediaProvider('a').notifier),
          c.read(liveMediaProvider('b').notifier),
        ),
        isFalse,
      );
    });
  });

  group('explicit connect', () {
    test(
      'joins once, hands the grant to the client, shows connecting',
      () async {
        final c = boot();
        final controller = ctrl(c);
        await controller.connect();

        expect(repo.joinCalls, 1);
        expect(client.connects.single.sessionId, 's-1');
        // Connected is the client's to report — the controller only shows the
        // operation in progress until the client's stream confirms.
        expect(stateOf(c), const LiveMediaConnecting());

        client.emit(const LiveMediaConnected());
        expect(stateOf(c), const LiveMediaConnected());
      },
    );

    test('an unavailable client yields unavailable and never joins', () async {
      final c = boot(media: const UnavailableLiveMediaClient());
      final controller = ctrl(c);
      await controller.connect();
      expect(stateOf(c), const LiveMediaUnavailable());
      expect(repo.joinCalls, 0);
    });
  });

  group('duplicate connect is ignored (no duplicate /join)', () {
    test('a second connect while one is in flight does nothing', () async {
      repo.holdJoin = Completer<void>();
      final c = boot();
      final controller = ctrl(c);

      final first = controller.connect(); // hangs on the held join
      await settle();
      await controller.connect(); // ignored — one already in flight
      expect(repo.joinCalls, 1);

      repo.holdJoin!.complete();
      await first;
      expect(repo.joinCalls, 1);
      expect(client.connects, hasLength(1));
    });

    test('connect while already connected does nothing', () async {
      final c = boot();
      final controller = ctrl(c);
      await controller.connect();
      client.emit(const LiveMediaConnected());

      await controller.connect();
      expect(repo.joinCalls, 1);
      expect(client.connects, hasLength(1));
    });
  });

  group('join failure', () {
    test(
      'surfaces the LiveException, never calls the client, stays idle',
      () async {
        repo.joinError = const LiveException('live.session_not_live', 'no');
        final c = boot();
        final controller = ctrl(c);

        await expectLater(controller.connect(), throwsA(isA<LiveException>()));
        expect(client.connects, isEmpty);
        expect(stateOf(c), const LiveMediaIdle());
      },
    );
  });

  group('media connect failure', () {
    test('shows failed, not a LiveException', () async {
      client.failNext = const LiveMediaException('connect_failed', 'x');
      final c = boot();
      final controller = ctrl(c);

      await controller.connect(); // does not throw
      expect(stateOf(c), const LiveMediaFailed());
    });
  });

  group('media state propagation', () {
    test('reflects every state the client emits', () async {
      final c = boot();
      ctrl(c);
      for (final s in <LiveMediaState>[
        const LiveMediaConnecting(),
        const LiveMediaConnected(),
        const LiveMediaReconnecting(),
        const LiveMediaFailed(),
        const LiveMediaDisconnected(LiveMediaDisconnectReason.other),
      ]) {
        client.emit(s);
        expect(stateOf(c), s);
      }
    });
  });

  group('terminal disconnect reasons', () {
    Future<ProviderContainer> connected() async {
      final c = boot();
      final controller = ctrl(c);
      await controller.connect();
      client.emit(const LiveMediaConnected());
      return c;
    }

    test('duplicateIdentity is terminal — no automatic /join', () async {
      final c = await connected();
      client.emit(
        const LiveMediaDisconnected(
          LiveMediaDisconnectReason.duplicateIdentity,
        ),
      );
      await settle();
      expect(
        stateOf(c),
        const LiveMediaDisconnected(
          LiveMediaDisconnectReason.duplicateIdentity,
        ),
      );
      expect(repo.joinCalls, 1); // no rejoin
      expect(repo.getSessionCalls, 0);
    });

    test('participantRemoved is terminal — no auto /join, but explicit connect still works', () async {
      final c = await connected();
      final controller = c.read(liveMediaProvider('s-1').notifier);
      client.emit(
        const LiveMediaDisconnected(
          LiveMediaDisconnectReason.participantRemoved,
        ),
      );
      await settle();
      expect(repo.joinCalls, 1); // no automatic rejoin
      expect(repo.getSessionCalls, 0);

      // Re-entry is allowed by the backend: an explicit connect joins again.
      await controller.connect();
      expect(repo.joinCalls, 2);
    });

    test('other is terminal for the controller — no auto /join', () async {
      await connected();
      client.emit(const LiveMediaDisconnected(LiveMediaDisconnectReason.other));
      await settle();
      expect(repo.joinCalls, 1);
      expect(repo.getSessionCalls, 0);
    });
  });

  group('roomDeleted (media reset)', () {
    Future<(ProviderContainer, LiveMediaController)> connected() async {
      final c = boot();
      final controller = ctrl(c);
      await controller.connect();
      client.emit(const LiveMediaConnected());
      return (c, controller);
    }

    test('session still live → one liveness read, then a fresh join', () async {
      final (c, _) = await connected();
      repo.sessionAnswer = (id) => _session(id, live: true);
      client.emit(
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
      await settle();

      expect(repo.getSessionCalls, 1); // one liveness check, not a loop
      expect(repo.joinCalls, 2); // fresh /join for the new room
      expect(client.connects, hasLength(2));
      expect(client.connects.last.token, 'token-for-s-1'); // a NEW grant
      expect(
        stateOf(c),
        const LiveMediaConnecting(),
      ); // the fresh join is in progress
    });

    test('session ended → no rejoin, stays disconnected', () async {
      final (c, _) = await connected();
      repo.sessionAnswer = (id) => _session(id, live: false);
      client.emit(
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
      await settle();

      expect(repo.getSessionCalls, 1);
      expect(repo.joinCalls, 1); // no fresh join
      expect(
        stateOf(c),
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
    });

    test('session gone (liveness read refused) → no rejoin', () async {
      final (c, _) = await connected();
      repo.getSessionError = const LiveException('live.session_not_found', 'x');
      client.emit(
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
      await settle();
      expect(repo.joinCalls, 1);
      expect(
        stateOf(c),
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
    });
  });

  group('explicit disconnect', () {
    test('tells the client to disconnect and returns to idle', () async {
      final c = boot();
      final controller = ctrl(c);
      await controller.connect();
      client.emit(const LiveMediaConnected());

      await controller.disconnect();
      expect(client.disconnects, 1);
      expect(stateOf(c), const LiveMediaIdle());
    });

    test(
      'a join that resolves after disconnect does NOT reconnect (stale)',
      () async {
        repo.holdJoin = Completer<void>();
        final c = boot();
        final controller = ctrl(c);

        final connecting = controller.connect(); // hangs on the held join
        await settle();
        expect(stateOf(c), const LiveMediaConnecting());

        await controller
            .disconnect(); // user leaves while the join is in flight
        expect(stateOf(c), const LiveMediaIdle());

        repo.holdJoin!.complete(); // the stale join now resolves
        await connecting;

        expect(client.connects, isEmpty); // never connected the stale grant
        expect(
          stateOf(c),
          const LiveMediaIdle(),
        ); // and did not flip to connecting
      },
    );
  });

  group('microphone and screen share', () {
    Future<LiveMediaController> connected(ProviderContainer c) async {
      final controller = ctrl(c);
      await controller.connect();
      client.emit(const LiveMediaConnected());
      return controller;
    }

    test('delegate to the client while connected', () async {
      final c = boot();
      final controller = await connected(c);
      await controller.setMicrophoneEnabled(true);
      await controller.setScreenShareEnabled(true);
      expect(client.microphoneCommands, [true]);
      expect(client.screenShareCommands, [true]);
      // The media state is unchanged — no fabricated authority or session.
      expect(stateOf(c), const LiveMediaConnected());
    });

    test('are rejected safely when not connected', () async {
      final c = boot();
      final controller = ctrl(c); // idle
      await expectLater(
        controller.setMicrophoneEnabled(true),
        throwsA(isA<LiveMediaException>()),
      );
      await expectLater(
        controller.setScreenShareEnabled(true),
        throwsA(isA<LiveMediaException>()),
      );
      expect(client.microphoneCommands, isEmpty);
      expect(client.screenShareCommands, isEmpty);
    });
  });

  group('disposal', () {
    test(
      'cancels the subscription — no reconnect, no callback after dispose',
      () async {
        final c = boot();
        final keepAlive = c.listen(liveMediaProvider('s-1'), (_, _) {});
        final controller = c.read(liveMediaProvider('s-1').notifier);
        await controller.connect();
        client.emit(const LiveMediaConnected());

        keepAlive.close(); // the autoDispose controller disposes now
        await settle();

        // A room-reset arriving after disposal must reach no handler: no
        // liveness read, no reconnect, and no thrown error.
        repo.sessionAnswer = (id) => _session(id, live: true);
        client.emit(
          const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
        );
        await settle();
        expect(repo.getSessionCalls, 0);
        expect(
          repo.joinCalls,
          1,
        ); // the one connect before disposal, nothing more
      },
    );
  });
}
