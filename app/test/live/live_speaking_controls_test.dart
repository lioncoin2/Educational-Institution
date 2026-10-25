import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

/// C15 issue 2 — the request-to-speak control follows the server's effective
/// speaking state, never a role name. The server's `me.canRaiseHand` is false
/// for someone who already speaks by right (a moderator holding `live.speak`),
/// so the dock offers them nothing to ask for; a granted speaker sees "yield",
/// not a second request; a listener, a revoked speaker and a student who only
/// presents their screen are offered the request. A permission change arrives
/// as `live.session.changed` and the screen re-reads the authoritative session.
class _FakeLive implements LiveRepository {
  _FakeLive(this.current);

  LiveSession current;
  final List<String> calls = [];

  @override
  Future<LiveSession?> currentSession(String communityId) async => current;

  @override
  Future<LiveSession> getSession(String sessionId) async {
    calls.add('getSession:$sessionId');
    return current;
  }

  // The speaking controls never reach any other command here.
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

var _version = 1;

LiveSession _session({
  bool canModerate = false,
  bool isHost = false,
  bool canRaiseHand = false,
  bool presenting = false,
  LiveParticipantRole? role,
  LiveMyHand? hand,
}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: LiveSessionState.live,
  stateVersion: _version,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 1,
  me: LiveMe(
    role:
        role ??
        (canModerate
            ? LiveParticipantRole.moderator
            : LiveParticipantRole.listener),
    isHost: isHost,
    canModerate: canModerate,
    canEnd: canModerate,
    canRaiseHand: canRaiseHand,
    presenting: presenting,
    hand: hand,
  ),
);

const _raise = Key('live-raise-hand');
const _lower = Key('live-lower-hand');

void main() {
  late FakeRealtimeClient realtime;

  setUp(() => realtime = FakeRealtimeClient());

  Future<_FakeLive> pump(WidgetTester tester, LiveSession session) async {
    final repo = _FakeLive(session);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(repo),
          realtimeConnectionProvider.overrideWithValue(realtime),
          liveMediaClientProvider.overrideWithValue(
            const UnavailableLiveMediaClient(),
          ),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: LiveSessionScreen(communityId: 'c-1'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return repo;
  }

  /// The server moved the session on: the screen re-reads it (newer version).
  Future<void> changed(
    WidgetTester tester,
    _FakeLive repo,
    LiveSession next,
  ) async {
    repo.current = next;
    realtime.emit(
      LiveSessionChangedEvent(
        eventId: 'live.session.changed:s-1:${next.stateVersion}',
        occurredAt: DateTime.utc(2026),
        communityId: 'c-1',
        sessionId: 's-1',
        stateVersion: next.stateVersion,
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('a host who speaks by right is offered no request to speak', (
    tester,
  ) async {
    await pump(tester, _session(isHost: true, canModerate: true));
    expect(find.byKey(_raise), findsNothing);
    expect(find.byKey(_lower), findsNothing);
    expect(find.text(LiveCopy.raiseHand), findsNothing);
    // Their moderator tools are still there — hiding the request hides nothing else.
    expect(find.byKey(const Key('live-end-session')), findsOneWidget);
  });

  testWidgets('a listener the server permits is offered the request', (
    tester,
  ) async {
    await pump(tester, _session(canRaiseHand: true));
    expect(find.byKey(_raise), findsOneWidget);
    expect(find.byKey(_lower), findsNothing);
  });

  testWidgets('a viewer the server does not permit sees no request', (
    tester,
  ) async {
    await pump(tester, _session());
    expect(find.byKey(_raise), findsNothing);
    expect(find.byKey(_lower), findsNothing);
  });

  testWidgets('a granted speaker sees "yield", never a second request', (
    tester,
  ) async {
    await pump(
      tester,
      _session(
        canRaiseHand: true,
        role: LiveParticipantRole.speaker,
        hand: const LiveMyHand(
          requestId: 'r-1',
          state: SpeakerRequestState.granted,
        ),
      ),
    );
    expect(find.byKey(_raise), findsNothing);
    expect(find.text(LiveCopy.yieldFloor), findsOneWidget);
  });

  testWidgets('a revoked speaker is offered the request again', (tester) async {
    await pump(
      tester,
      _session(
        canRaiseHand: true,
        hand: const LiveMyHand(
          requestId: 'r-1',
          state: SpeakerRequestState.revoked,
        ),
      ),
    );
    expect(find.byKey(_raise), findsOneWidget);
    expect(find.byKey(_lower), findsNothing);
  });

  testWidgets(
    'screen sharing is not speaking: a presenting student may still ask',
    (tester) async {
      await pump(tester, _session(canRaiseHand: true, presenting: true));
      expect(find.byKey(_raise), findsOneWidget);
    },
  );

  testWidgets(
    'follows the server live: request → pending → granted → revoked',
    (tester) async {
      _version = 1;
      final repo = await pump(tester, _session(canRaiseHand: true));
      expect(find.byKey(_raise), findsOneWidget);

      _version = 2;
      await changed(
        tester,
        repo,
        _session(
          canRaiseHand: true,
          hand: const LiveMyHand(
            requestId: 'r-1',
            state: SpeakerRequestState.pending,
          ),
        ),
      );
      expect(find.byKey(_raise), findsNothing);
      expect(find.text(LiveCopy.lowerHand), findsOneWidget);

      _version = 3;
      await changed(
        tester,
        repo,
        _session(
          canRaiseHand: true,
          role: LiveParticipantRole.speaker,
          hand: const LiveMyHand(
            requestId: 'r-1',
            state: SpeakerRequestState.granted,
          ),
        ),
      );
      expect(find.byKey(_raise), findsNothing);
      expect(find.text(LiveCopy.yieldFloor), findsOneWidget);

      _version = 4;
      await changed(
        tester,
        repo,
        _session(
          canRaiseHand: true,
          hand: const LiveMyHand(
            requestId: 'r-1',
            state: SpeakerRequestState.revoked,
          ),
        ),
      );
      expect(find.byKey(_raise), findsOneWidget);
      expect(find.text(LiveCopy.yieldFloor), findsNothing);

      // Promoted to moderator mid-session (they now speak by right): the server
      // stops offering the request, and so does the dock.
      _version = 5;
      await changed(tester, repo, _session(canModerate: true));
      expect(find.byKey(_raise), findsNothing);
      expect(repo.calls.where((c) => c.startsWith('getSession')).length, 4);
    },
  );
}
