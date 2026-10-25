import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/widgets/live_roster.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

/// Fix #3 (raise-hand reaches the moderator), at the widget level. The hands
/// queue has no realtime feed of its own, but the session's `stateVersion`
/// already advances on every hand/floor change (relayed as `live.session.changed`
/// to moderators). The roster listens to that version and re-reads its page when
/// it advances — using only the EXISTING contract, with no new event or API, and
/// without a duplicate read when nothing changed.
class _FakeLive implements LiveRepository {
  Future<LiveSession?> Function(String communityId) onCurrent = (_) async =>
      null;
  Future<LiveSession> Function(String sessionId) onGet = (_) async =>
      throw StateError('getSession not configured');

  /// Every hands read, in order — the count is the subject of these tests.
  final List<String> handsCalls = [];

  @override
  Future<LiveSession?> currentSession(String communityId) =>
      onCurrent(communityId);

  @override
  Future<LiveSession> getSession(String sessionId) => onGet(sessionId);

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async {
    handsCalls.add(sessionId);
    return const LiveHandsPage(
      items: [],
      nextCursor: null,
      origin: DataOrigin.records,
    );
  }

  // Not exercised by the roster-sync path.
  @override
  Future<LiveSession> start(String communityId) => throw UnimplementedError();
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
  Future<LiveMediaGrant> join(String sessionId) => throw UnimplementedError();
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

LiveSession _session({required int version}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: LiveSessionState.live,
  stateVersion: version,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 1,
  me: const LiveMe(role: LiveParticipantRole.moderator, canModerate: true),
);

var _seq = 0;
LiveSessionChangedEvent _changed({required int version}) =>
    LiveSessionChangedEvent(
      eventId: 'live.session.changed:${_seq++}',
      occurredAt: DateTime.utc(2026),
      communityId: 'c-1',
      sessionId: 's-1',
      stateVersion: version,
    );

void main() {
  late _FakeLive repo;
  late FakeRealtimeClient realtime;

  setUp(() {
    repo = _FakeLive();
    realtime = FakeRealtimeClient();
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(repo),
          realtimeConnectionProvider.overrideWithValue(realtime),
          sessionUserProvider.overrideWith((ref) async => null),
          liveMediaClientProvider.overrideWithValue(
            const UnavailableLiveMediaClient(),
          ),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Directionality(
              textDirection: TextDirection.rtl,
              child: SingleChildScrollView(
                child: LiveRoster(session: _session(version: 1)),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('re-reads the hands page once each time the session stateVersion '
      'advances, and not on a stale/equal version', (tester) async {
    repo.onCurrent = (_) async => _session(version: 1);
    repo.onGet = (_) async => _session(version: 2);
    await pump(tester);

    final before = repo.handsCalls.length;
    expect(
      before,
      greaterThanOrEqualTo(1),
      reason: 'the roster read its first page on build',
    );

    // The default «الكل» view reads two sides (granted speakers + the queue),
    // so one advance re-reads each side exactly once.
    const sides = 2;

    // A `changed` hint newer than what is held → the controller reconciles over
    // HTTP, the held stateVersion goes 1→2, and the roster re-reads once.
    realtime.emit(_changed(version: 2));
    await tester.pumpAndSettle();
    expect(repo.handsCalls.length, before + sides);

    // A further advance → exactly one more re-read.
    repo.onGet = (_) async => _session(version: 3);
    realtime.emit(_changed(version: 3));
    await tester.pumpAndSettle();
    expect(repo.handsCalls.length, before + 2 * sides);

    // A stale/equal version is old news: the controller does not reconcile, so
    // the roster issues no duplicate read.
    realtime.emit(_changed(version: 3));
    await tester.pumpAndSettle();
    expect(repo.handsCalls.length, before + 2 * sides);
  });

  testWidgets('a `changed` for another community never re-reads this roster', (
    tester,
  ) async {
    repo.onCurrent = (_) async => _session(version: 1);
    repo.onGet = (_) async => _session(version: 9);
    await pump(tester);
    final before = repo.handsCalls.length;

    realtime.emit(
      LiveSessionChangedEvent(
        eventId: 'live.session.changed:other',
        occurredAt: DateTime.utc(2026),
        communityId: 'c-OTHER',
        sessionId: 's-OTHER',
        stateVersion: 99,
      ),
    );
    await tester.pumpAndSettle();
    expect(repo.handsCalls.length, before);
  });
}
