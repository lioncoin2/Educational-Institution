import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_live_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/state/live_session_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

/// A live repository the test drives, recording every read so the controller's
/// reconciliation can be asserted exactly: how many `currentSession` (doorway)
/// and `getSession` (by-id) reads it made, and with what id.
class _FakeLive implements LiveRepository {
  /// The doorway read. Replace per test; defaults to "none running".
  Future<LiveSession?> Function(String communityId) onCurrent = (_) async =>
      null;

  /// The by-id read. Replace per test; a test that triggers it configures it.
  Future<LiveSession> Function(String sessionId) onGet = (_) async =>
      throw StateError('getSession called but not configured');

  int currentCalls = 0;
  int getCalls = 0;
  final List<String> getIds = [];

  @override
  Future<LiveSession?> currentSession(String communityId) {
    currentCalls += 1;
    return onCurrent(communityId);
  }

  @override
  Future<LiveSession> getSession(String sessionId) {
    getCalls += 1;
    getIds.add(sessionId);
    return onGet(sessionId);
  }

  // The hand queue is not exercised by the controller.
  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) => throw UnimplementedError();
}

LiveSession _session({
  String id = 's-1',
  String community = 'c-1',
  LiveSessionState state = LiveSessionState.live,
  int stateVersion = 1,
  LiveSessionEndReason? endReason,
  DateTime? endedAt,
}) => LiveSession(
  id: id,
  communityId: community,
  state: state,
  stateVersion: stateVersion,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  endedAt: endedAt,
  endReason: endReason,
  speakerCount: 1,
  me: const LiveMe(role: LiveParticipantRole.listener),
);

var _seq = 0;
final _at = DateTime.utc(2026);

LiveSessionStartedEvent _started({
  String community = 'c-1',
  String id = 's-1',
}) => LiveSessionStartedEvent(
  eventId: 'live.session.started:${_seq++}',
  occurredAt: _at,
  communityId: community,
  sessionId: id,
);

LiveSessionChangedEvent _changed({
  String community = 'c-1',
  String id = 's-1',
  required int version,
}) => LiveSessionChangedEvent(
  eventId: 'live.session.changed:${_seq++}',
  occurredAt: _at,
  communityId: community,
  sessionId: id,
  stateVersion: version,
);

LiveSessionEndedEvent _ended({
  String community = 'c-1',
  String id = 's-1',
  LiveSessionEndReason reason = LiveSessionEndReason.moderator,
}) => LiveSessionEndedEvent(
  eventId: 'live.session.ended:${_seq++}',
  occurredAt: _at,
  communityId: community,
  sessionId: id,
  reason: reason,
);

LiveParticipantRemovedEvent _participantRemoved({
  String community = 'c-1',
  String id = 's-1',
}) => LiveParticipantRemovedEvent(
  eventId: 'live.participant.removed:${_seq++}',
  occurredAt: _at,
  communityId: community,
  sessionId: id,
);

LiveSessionMediaResetEvent _mediaReset({
  String community = 'c-1',
  String id = 's-1',
}) => LiveSessionMediaResetEvent(
  eventId: 'live.session.media_reset:${_seq++}',
  occurredAt: _at,
  communityId: community,
  sessionId: id,
);

void main() {
  late _FakeLive repo;
  late FakeRealtimeClient realtime;

  setUp(() {
    repo = _FakeLive();
    realtime = FakeRealtimeClient();
  });

  ProviderContainer boot() {
    final container = ProviderContainer(
      overrides: [
        liveRepositoryProvider.overrideWithValue(repo),
        realtimeConnectionProvider.overrideWithValue(realtime),
        sessionUserProvider.overrideWith((ref) async => null),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  Future<LiveSession?> load(ProviderContainer c, [String id = 'c-1']) {
    final keepAlive = c.listen(liveSessionProvider(id), (_, _) {});
    addTearDown(keepAlive.close);
    return c.read(liveSessionProvider(id).future);
  }

  LiveSession? current(ProviderContainer c, [String id = 'c-1']) =>
      c.read(liveSessionProvider(id)).value;

  Future<void> settle() => pumpEventQueue();

  group('initial load', () {
    test('is null when no session is running', () async {
      repo.onCurrent = (_) async => null;
      expect(await load(boot()), isNull);
    });

    test('is the community’s running session when one is', () async {
      repo.onCurrent = (id) async => _session(community: id);
      final session = await load(boot());
      expect(session, isNotNull);
      expect(session!.communityId, 'c-1');
      expect(session.isLive, isTrue);
      expect(repo.getCalls, 0); // the doorway read, not a by-id read
    });

    test('surfaces a refusal as an error, fabricating no session', () async {
      repo.onCurrent = (_) async =>
          throw const LiveException('unavailable', 'no');
      final c = boot();
      final keepAlive = c.listen(liveSessionProvider('c-1'), (_, _) {});
      addTearDown(keepAlive.close);
      await expectLater(
        c.read(liveSessionProvider('c-1').future),
        throwsA(isA<LiveException>()),
      );
      expect(c.read(liveSessionProvider('c-1')).hasError, isTrue);
    });

    test('refresh reads the current session again', () async {
      repo.onCurrent = (id) async => _session(community: id);
      final c = boot();
      await load(c);
      expect(repo.currentCalls, 1);
      await c.read(liveSessionProvider('c-1').notifier).refresh();
      expect(repo.currentCalls, 2);
    });
  });

  group('session identity', () {
    setUp(() {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
      repo.onGet = (id) async => _session(id: id, stateVersion: 9);
    });

    test('a changed event for our community and session reconciles', () async {
      final c = boot();
      await load(c);
      realtime.emit(_changed(version: 5));
      await settle();
      expect(repo.getCalls, 1);
      expect(repo.getIds.single, 's-1');
      expect(current(c)!.stateVersion, 9); // the authoritative read
    });

    test('an event for another community is ignored', () async {
      final c = boot();
      await load(c);
      realtime.emit(_changed(community: 'c-OTHER', version: 99));
      realtime.emit(_started(community: 'c-OTHER'));
      await settle();
      expect(repo.getCalls, 0);
      expect(repo.currentCalls, 1); // no re-discovery either
      expect(current(c)!.stateVersion, 1);
    });

    test('a changed event for another session is ignored', () async {
      final c = boot();
      await load(c);
      realtime.emit(_changed(id: 's-OTHER', version: 99));
      await settle();
      expect(repo.getCalls, 0);
      expect(current(c)!.stateVersion, 1);
    });
  });

  group('stateVersion reconciliation', () {
    test('a newer version triggers exactly one getSession', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 2);
      repo.onGet = (id) async => _session(id: id, stateVersion: 3);
      final c = boot();
      await load(c);
      realtime.emit(_changed(version: 3));
      await settle();
      expect(repo.getCalls, 1);
      expect(current(c)!.stateVersion, 3);
    });

    test('an equal version does not fetch', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 2);
      repo.onGet = (id) async => _session(id: id, stateVersion: 2);
      final c = boot();
      await load(c);
      realtime.emit(_changed(version: 2));
      await settle();
      expect(repo.getCalls, 0);
    });

    test('an older version does not fetch', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 5);
      repo.onGet = (id) async => _session(id: id, stateVersion: 5);
      final c = boot();
      await load(c);
      realtime.emit(_changed(version: 3));
      await settle();
      expect(repo.getCalls, 0);
      expect(current(c)!.stateVersion, 5);
    });

    test(
      'several newer events settle on the newest, no stale overwrite',
      () async {
        var serverVersion = 3;
        repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
        repo.onGet = (id) async =>
            _session(id: id, stateVersion: serverVersion);
        final c = boot();
        await load(c);

        // Two newer hints back-to-back: single-flight coalesces, newest wins.
        realtime.emit(_changed(version: 2));
        realtime.emit(_changed(version: 3));
        await settle();
        expect(current(c)!.stateVersion, 3);

        // A late, older hint must neither fetch nor undo the newer state.
        final before = repo.getCalls;
        serverVersion = 99; // would be applied if a stale hint fetched
        realtime.emit(_changed(version: 2));
        await settle();
        expect(repo.getCalls, before);
        expect(current(c)!.stateVersion, 3);
      },
    );
  });

  group('realtime lifecycle events', () {
    test('a started event discovers a session that was absent', () async {
      repo.onCurrent = (_) async => null; // none at first
      final c = boot();
      expect(await load(c), isNull);

      repo.onCurrent = (id) async => _session(community: id); // one starts
      realtime.emit(_started());
      await settle();
      expect(current(c), isNotNull);
      expect(current(c)!.isLive, isTrue);
      expect(repo.currentCalls, 2); // doorway again, not getSession
      expect(repo.getCalls, 0);
    });

    test(
      'a started event for the session already held does not re-read',
      () async {
        repo.onCurrent = (id) async => _session(community: id);
        final c = boot();
        await load(c);
        realtime.emit(_started());
        await settle();
        expect(repo.currentCalls, 1); // already have it, live — nothing to do
        expect(repo.getCalls, 0);
      },
    );

    test('an ended event reconciles to the authoritative ended view', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
      repo.onGet = (id) async => _session(
        id: id,
        state: LiveSessionState.ended,
        stateVersion: 2,
        endedAt: DateTime.utc(2026, 1, 2),
        endReason: LiveSessionEndReason.idle,
      );
      final c = boot();
      await load(c);
      realtime.emit(_ended(reason: LiveSessionEndReason.idle));
      await settle();
      expect(repo.getCalls, 1);
      expect(current(c)!.isLive, isFalse);
      expect(current(c)!.state, LiveSessionState.ended);
      expect(current(c)!.endReason, LiveSessionEndReason.idle);
      expect(current(c)!.endedAt, isNotNull);
    });

    test(
      'an ended event whose session the backend no longer has clears it',
      () async {
        repo.onCurrent = (id) async => _session(community: id);
        repo.onGet = (_) async =>
            throw const LiveException('live.session_not_found', 'gone');
        final c = boot();
        await load(c);
        realtime.emit(_ended());
        await settle();
        expect(repo.getCalls, 1);
        expect(current(c), isNull); // over — the doorway semantics
      },
    );

    test(
      'participant removed changes no session state (non-media phase)',
      () async {
        repo.onCurrent = (id) async => _session(community: id, stateVersion: 4);
        final c = boot();
        await load(c);
        final held = current(c);
        realtime.emit(_participantRemoved());
        await settle();
        expect(repo.getCalls, 0); // no by-id read
        expect(repo.currentCalls, 1); // no re-discovery
        expect(current(c), same(held)); // untouched — no fabricated identity
      },
    );

    test('media reset changes no session state (non-media phase)', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 4);
      final c = boot();
      await load(c);
      final held = current(c);
      realtime.emit(_mediaReset());
      await settle();
      expect(repo.getCalls, 0);
      expect(current(c), same(held));
      expect(current(c)!.stateVersion, 4); // unrelated state not lost
    });
  });

  group('reconnect re-synchronisation', () {
    test('a reconnected status re-reads the authoritative session', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
      final c = boot();
      await load(c);
      expect(repo.currentCalls, 1);

      realtime.setStatus(RealtimeStatus.reconnecting); // not live: no read
      await settle();
      expect(repo.currentCalls, 1);

      realtime.setStatus(RealtimeStatus.reconnected); // live again: re-read
      await settle();
      expect(repo.currentCalls, 2);
    });

    test('reconnect restores authority after missed events', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
      final c = boot();
      await load(c);
      expect(current(c)!.stateVersion, 1);

      // While the connection was gone, the session advanced; the hints never
      // arrived. The reconnect re-read catches up regardless.
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 7);
      realtime.setStatus(RealtimeStatus.reconnecting);
      realtime.setStatus(RealtimeStatus.reconnected);
      await settle();
      expect(current(c)!.stateVersion, 7);
    });

    test(
      'a session ended while away is reflected as none on reconnect',
      () async {
        repo.onCurrent = (id) async => _session(community: id);
        final c = boot();
        await load(c);
        expect(current(c), isNotNull);

        repo.onCurrent = (_) async => null; // ended while disconnected
        realtime.setStatus(RealtimeStatus.reconnected);
        await settle();
        expect(current(c), isNull);
      },
    );
  });

  group('errors during reconciliation', () {
    test('a transient getSession failure keeps what is shown', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
      repo.onGet = (_) async => throw const LiveException('unavailable', 'no');
      final c = boot();
      await load(c);
      final held = current(c);
      realtime.emit(_changed(version: 5));
      await settle();
      expect(repo.getCalls, 1); // it tried
      expect(current(c), same(held)); // but kept the known-good session
      expect(c.read(liveSessionProvider('c-1')).hasError, isFalse);
    });

    test('a transient reconnect failure keeps what is shown', () async {
      var fail = false;
      repo.onCurrent = (id) async {
        if (fail) throw const LiveException('unavailable', 'no');
        return _session(community: id, stateVersion: 2);
      };
      final c = boot();
      await load(c);
      final held = current(c);
      fail = true;
      realtime.setStatus(RealtimeStatus.reconnected);
      await settle();
      expect(current(c), same(held));
    });
  });

  group('subscription lifecycle', () {
    test('no realtime read reaches the controller after disposal', () async {
      repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
      repo.onGet = (id) async => _session(id: id, stateVersion: 9);
      // A container disposed by hand (no addTearDown double-dispose).
      final c = ProviderContainer(
        overrides: [
          liveRepositoryProvider.overrideWithValue(repo),
          realtimeConnectionProvider.overrideWithValue(realtime),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
      );
      final keepAlive = c.listen(liveSessionProvider('c-1'), (_, _) {});
      await c.read(liveSessionProvider('c-1').future);
      keepAlive.close();
      c.dispose();

      realtime.emit(_changed(version: 9)); // nobody is listening now
      await settle();
      expect(repo.getCalls, 0);
    });

    test(
      'a rebuild leaves exactly one listener — no duplicate reconciliation',
      () async {
        repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
        repo.onGet = (id) async => _session(id: id, stateVersion: 2);
        final c = boot();
        await load(c);
        await c.read(liveSessionProvider('c-1').notifier).refresh(); // rebuild
        realtime.emit(_changed(version: 2));
        await settle();
        expect(repo.getCalls, 1); // one listener → one read, not two
      },
    );
  });

  group('end-reason enum convergence', () {
    test(
      'the ended frame and the model share one LiveSessionEndReason',
      () async {
        repo.onCurrent = (id) async => _session(community: id, stateVersion: 1);
        repo.onGet = (id) async => _session(
          id: id,
          state: LiveSessionState.ended,
          stateVersion: 2,
          endReason: LiveSessionEndReason.communityClosed,
        );
        final c = boot();
        await load(c);
        // The event carries the model enum (one type now); the reconciled
        // session exposes the same one.
        final event = _ended(reason: LiveSessionEndReason.communityClosed);
        expect(event.reason, isA<LiveSessionEndReason>());
        realtime.emit(event);
        await settle();
        expect(current(c)!.endReason, LiveSessionEndReason.communityClosed);
      },
    );
  });

  group('MockLiveRepository', () {
    test('answers a demo session for a live community, flagged mock', () async {
      final mock = MockLiveRepository(latency: Duration.zero);
      final session = await mock.currentSession('mock-community-live');
      expect(session, isNotNull);
      expect(session!.isLive, isTrue);
      expect(session.origin, DataOrigin.mock);
    });

    test('answers null for a community with no running session', () async {
      final mock = MockLiveRepository(latency: Duration.zero);
      expect(await mock.currentSession('a-quiet-community'), isNull);
    });
  });
}
