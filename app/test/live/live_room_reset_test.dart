import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/features/live/state/live_media_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'fake_live_media_client.dart';

/// C15 issue 4 — the room reset (Q64, ADR 0026) is a media-room generation
/// swap: everyone is dropped from the old room and re-joins the new one; no
/// floor, presenter slot, chat message or record is touched. Proven on Trial
/// to work on the server, it failed people on screen: the moderator was told
/// "done" whatever the server answered, the drop read as a plain
/// disconnection, and nobody was told that their floor or presenter slot was
/// kept but their microphone / shared screen had to be turned back on — so a
/// speaker yielded and re-asked, a presenter gave up and re-claimed. These
/// tests pin the fixed behaviour.
class _FakeLive implements LiveRepository {
  _FakeLive(this.session);

  LiveSession session;
  LiveSession? rejoinAnswer;
  final List<String> calls = [];
  bool resetAnswer = true;
  Object? resetError;
  Completer<void>? holdReset;

  @override
  Future<LiveSession?> currentSession(String communityId) async => session;

  @override
  Future<LiveSession> getSession(String sessionId) async {
    calls.add('getSession');
    return rejoinAnswer ?? session;
  }

  @override
  Future<bool> resetRoom(String sessionId) async {
    calls.add('resetRoom:$sessionId');
    if (holdReset != null) await holdReset!.future;
    if (resetError != null) throw resetError!;
    return resetAnswer;
  }

  @override
  Future<LiveMediaGrant> join(String sessionId) async {
    calls.add('join');
    return LiveMediaGrant(
      sessionId: sessionId,
      token: 't',
      url: 'wss://live.test',
      expiresInSeconds: 120,
      expiresAt: DateTime.utc(2030),
      role: session.me.role,
      microphone: true,
      screen: session.me.presenting,
      screenAudio: false,
    );
  }

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async => const LiveHandsPage(items: [], nextCursor: null);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

LiveSession _session({
  bool moderator = false,
  bool presenting = false,
  LiveMyHand? hand,
  LiveSessionState state = LiveSessionState.live,
}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: state,
  stateVersion: 1,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 1,
  me: LiveMe(
    role: moderator
        ? LiveParticipantRole.moderator
        : hand?.state == SpeakerRequestState.granted
        ? LiveParticipantRole.speaker
        : LiveParticipantRole.listener,
    canJoin: true,
    canModerate: moderator,
    canEnd: moderator,
    presenting: presenting,
    hand: hand,
  ),
);

const _granted = LiveMyHand(
  requestId: 'r-1',
  state: SpeakerRequestState.granted,
);

void main() {
  late FakeLiveMediaClient media;

  setUp(() => media = FakeLiveMediaClient(initial: const LiveMediaConnected()));

  Future<_FakeLive> pump(WidgetTester tester, LiveSession session) async {
    final live = _FakeLive(session);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(live),
          liveMediaClientProvider.overrideWithValue(media),
          realtimeConnectionProvider.overrideWithValue(FakeRealtimeClient()),
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
    return live;
  }

  Future<void> confirmReset(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('live-reset-room')));
    await tester.pumpAndSettle();
    await tester.tap(find.text(LiveCopy.resetRoomConfirm));
    await tester.pumpAndSettle();
  }

  group('the moderator’s reset button', () {
    testWidgets('says done only when the server moved the room', (
      tester,
    ) async {
      final live = await pump(tester, _session(moderator: true));
      await confirmReset(tester);
      expect(live.calls, ['resetRoom:s-1']);
      expect(find.text(LiveCopy.resetRoomDone), findsOneWidget);
    });

    testWidgets('says nothing changed when the server answered reset: false', (
      tester,
    ) async {
      final live = await pump(tester, _session(moderator: true))
        ..resetAnswer = false;
      await confirmReset(tester);
      expect(live.calls, ['resetRoom:s-1']);
      expect(find.text(LiveCopy.resetRoomUnchanged), findsOneWidget);
      expect(find.text(LiveCopy.resetRoomDone), findsNothing);
    });

    testWidgets('a refusal is said through the server’s code — never "done"', (
      tester,
    ) async {
      final live = await pump(tester, _session(moderator: true))
        ..resetError = const LiveException('live.not_a_moderator', 'x');
      await confirmReset(tester);
      expect(
        find.text(LiveCopy.commandError('live.not_a_moderator')),
        findsOneWidget,
      );
      expect(find.text(LiveCopy.resetRoomDone), findsNothing);
      expect(live.calls, ['resetRoom:s-1']);
    });

    testWidgets('repeated taps open one question and send one reset', (
      tester,
    ) async {
      final live = await pump(tester, _session(moderator: true));
      live.holdReset = Completer();
      await tester.tap(find.byKey(const Key('live-reset-room')));
      await tester.tap(
        find.byKey(const Key('live-reset-room')),
        warnIfMissed: false,
      );
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.text(LiveCopy.resetRoomConfirm));
      await tester.pump();
      await tester.pump(
        const Duration(milliseconds: 400),
      ); // the question closes
      expect(find.byType(AlertDialog), findsNothing);
      // In flight: further taps ask nothing and send nothing.
      await tester.tap(
        find.byKey(const Key('live-reset-room')),
        warnIfMissed: false,
      );
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(AlertDialog), findsNothing);
      live.holdReset!.complete();
      await tester.pumpAndSettle();
      expect(live.calls, ['resetRoom:s-1']);
    });

    testWidgets('dismissing the question sends nothing', (tester) async {
      final live = await pump(tester, _session(moderator: true));
      await tester.tap(find.byKey(const Key('live-reset-room')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(LiveCopy.cancel));
      await tester.pumpAndSettle();
      expect(live.calls, isEmpty);
    });
  });

  group('everyone in the room, when it is reset', () {
    Future<void> roomReplaced(WidgetTester tester) async {
      media.emit(
        const LiveMediaDisconnected(LiveMediaDisconnectReason.roomDeleted),
      );
      await tester.pump(); // the liveness read
      await tester.pump(); // the fresh join
    }

    testWidgets(
      're-joins the new room and says why — not a plain disconnection',
      (tester) async {
        final live = await pump(tester, _session(hand: _granted));
        await roomReplaced(tester);
        expect(live.calls, ['getSession', 'join']);
        expect(media.connects, hasLength(1));
        expect(find.text(LiveCopy.roomResetRejoining), findsOneWidget);
        expect(find.text(LiveCopy.audioDisconnected), findsNothing);

        media.emit(const LiveMediaConnected());
        await tester.pump();
        expect(find.text(LiveCopy.roomResetDone), findsOneWidget);
        // A speaker keeps the floor, but the microphone did not survive the swap.
        expect(find.text(LiveCopy.roomResetMicHint), findsOneWidget);
        expect(find.text(LiveCopy.yieldFloor), findsOneWidget);

        media.emitPublication(const LiveMediaPublication(microphoneOn: true));
        await tester.pump();
        expect(find.text(LiveCopy.roomResetMicHint), findsNothing);

        // The note goes by itself.
        await tester.pump(LiveRoomResetNotifier.shown);
        await tester.pump();
        expect(find.text(LiveCopy.roomResetDone), findsNothing);
        expect(find.text(LiveCopy.audioConnectedTitle), findsOneWidget);
      },
    );

    testWidgets(
      'tells a presenter to share again, a listener only that it was reset',
      (tester) async {
        await pump(tester, _session(presenting: true));
        await roomReplaced(tester);
        media.emit(const LiveMediaConnected());
        await tester.pump();
        expect(find.text(LiveCopy.roomResetScreenHint), findsOneWidget);
        expect(find.text(LiveCopy.roomResetMicHint), findsNothing);
        await tester.pumpAndSettle(LiveRoomResetNotifier.shown);
      },
    );

    testWidgets(
      'a listener is told the room was reset, with no hint to act on',
      (tester) async {
        await pump(tester, _session());
        await roomReplaced(tester);
        media.emit(const LiveMediaConnected());
        await tester.pump();
        expect(find.text(LiveCopy.roomResetDone), findsOneWidget);
        expect(find.text(LiveCopy.roomResetMicHint), findsNothing);
        expect(find.text(LiveCopy.roomResetScreenHint), findsNothing);
        await tester.pumpAndSettle(LiveRoomResetNotifier.shown);
      },
    );

    testWidgets(
      'a room deleted because the session ENDED is no reset: no re-join, no note',
      (tester) async {
        final live = await pump(tester, _session(hand: _granted));
        live.rejoinAnswer = _session(state: LiveSessionState.ended);
        await roomReplaced(tester);
        await tester.pumpAndSettle();
        expect(live.calls, ['getSession']);
        expect(media.connects, isEmpty);
        expect(find.text(LiveCopy.roomResetRejoining), findsNothing);
        expect(find.text(LiveCopy.roomResetDone), findsNothing);
      },
    );

    testWidgets('leaving clears the note', (tester) async {
      await pump(tester, _session(hand: _granted));
      await roomReplaced(tester);
      media.emit(const LiveMediaConnected());
      await tester.pump();
      expect(find.text(LiveCopy.roomResetDone), findsOneWidget);
      await tester.tap(find.byKey(const Key('live-audio-leave')));
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.roomResetDone), findsNothing);
      expect(find.text(LiveCopy.roomResetMicHint), findsNothing);
    });
  });
}
