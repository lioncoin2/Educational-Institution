import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_room.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/features/live/state/live_reactions_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

/// C15 issue 3 — the live room's four reactions (ADR 0049): ❤️ 👍 👏 😊, the
/// four the strip has always shown. A tap draws the viewer's own reaction at
/// once and sends it; another participant's arrives as a `live.reaction` frame
/// and floats up the stage; nothing names who reacted. Only participants may
/// react; a refusal is said through the server's code; nothing lingers.
class _FakeLive implements LiveRepository {
  _FakeLive(this.session);

  final LiveSession session;

  @override
  Future<LiveSession?> currentSession(String communityId) async => session;

  @override
  Future<LiveSession> getSession(String sessionId) async => session;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

class _FakeRoom implements LiveRoomRepository {
  final List<String> sent = [];
  Object? fail;

  @override
  Future<Uri?> participantAvatarUrl(String sessionId, String userId) async =>
      null;

  @override
  Future<void> react(String sessionId, LiveReactionKind kind) async {
    sent.add('$sessionId:${kind.wire}');
    if (fail != null) throw fail!;
  }
}

LiveSession _session({bool canJoin = true, bool canModerate = false}) =>
    LiveSession(
      id: 's-1',
      communityId: 'c-1',
      state: LiveSessionState.live,
      stateVersion: 1,
      hostUserId: 'u-host',
      startedAt: DateTime.utc(2026),
      speakerCount: 1,
      me: LiveMe(
        role: LiveParticipantRole.listener,
        canJoin: canJoin,
        canModerate: canModerate,
      ),
    );

var _seq = 0;
LiveReactionEvent _frame(
  LiveReactionKind kind, {
  String sessionId = 's-1',
  String? eventId,
}) => LiveReactionEvent(
  eventId: eventId ?? 'live.reaction:$sessionId:${_seq++}',
  occurredAt: DateTime.utc(2026),
  communityId: 'c-1',
  sessionId: sessionId,
  kind: kind,
);

Finder _burst(LiveReactionKind kind) =>
    find.byKey(Key('live-reaction-burst-${kind.wire}'));

void main() {
  late FakeRealtimeClient realtime;
  late _FakeRoom room;

  setUp(() {
    realtime = FakeRealtimeClient();
    room = _FakeRoom();
  });

  Future<void> pump(WidgetTester tester, LiveSession session) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(_FakeLive(session)),
          liveRoomRepositoryProvider.overrideWithValue(room),
          liveMediaClientProvider.overrideWithValue(
            const UnavailableLiveMediaClient(),
          ),
          realtimeConnectionProvider.overrideWithValue(realtime),
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
  }

  testWidgets('shows the four reactions — and only these four', (tester) async {
    await pump(tester, _session());
    for (final kind in LiveReactionKind.values) {
      expect(find.byKey(Key('live-react-${kind.wire}')), findsOneWidget);
    }
    expect(LiveReactionKind.values.map((k) => k.wire), [
      'heart',
      'thumbs_up',
      'clap',
      'smile',
    ]);
  });

  testWidgets(
    'a tap draws the viewer’s reaction at once, sends it, and it floats away',
    (tester) async {
      await pump(tester, _session());
      await tester.tap(find.byKey(const Key('live-react-clap')));
      await tester.pump();
      expect(room.sent, ['s-1:clap']);
      expect(_burst(LiveReactionKind.clap), findsOneWidget);
      await tester.pump(LiveReactionsController.shown);
      await tester.pumpAndSettle();
      expect(_burst(LiveReactionKind.clap), findsNothing);
    },
  );

  testWidgets('the dock’s quick reaction sends a heart', (tester) async {
    await pump(tester, _session());
    await tester.tap(find.byKey(const Key('live-dock-react')));
    await tester.pump();
    expect(room.sent, ['s-1:heart']);
    await tester.pumpAndSettle(LiveReactionsController.shown);
  });

  testWidgets(
    'a held finger does not flood: taps inside the cooldown send nothing',
    (tester) async {
      await pump(tester, _session());
      for (var i = 0; i < 5; i += 1) {
        await tester.tap(find.byKey(const Key('live-react-heart')));
      }
      await tester.pump();
      expect(room.sent, ['s-1:heart']);
      await tester.pump(LiveReactionsController.cooldown);
      await tester.tap(find.byKey(const Key('live-react-heart')));
      await tester.pump();
      expect(room.sent, ['s-1:heart', 's-1:heart']);
      await tester.pumpAndSettle(LiveReactionsController.shown);
    },
  );

  testWidgets(
    'another participant’s reaction floats up — once, however often it is delivered',
    (tester) async {
      await pump(tester, _session());
      final frame = _frame(LiveReactionKind.smile);
      realtime.emit(frame);
      realtime.emit(frame); // a redelivery
      await tester.pump();
      expect(_burst(LiveReactionKind.smile), findsOneWidget);
      expect(room.sent, isEmpty);
      await tester.pumpAndSettle(LiveReactionsController.shown);
      expect(_burst(LiveReactionKind.smile), findsNothing);
    },
  );

  testWidgets('another session’s reactions never reach this room', (
    tester,
  ) async {
    await pump(tester, _session());
    realtime.emit(_frame(LiveReactionKind.heart, sessionId: 's-other'));
    await tester.pump();
    expect(_burst(LiveReactionKind.heart), findsNothing);
  });

  testWidgets('a reconnect replays nothing and loses nothing to come', (
    tester,
  ) async {
    await pump(tester, _session());
    realtime.setStatus(RealtimeStatus.reconnecting);
    await tester.pump();
    realtime.setStatus(RealtimeStatus.reconnected);
    await tester.pumpAndSettle();
    expect(_burst(LiveReactionKind.thumbsUp), findsNothing);
    realtime.emit(_frame(LiveReactionKind.thumbsUp));
    await tester.pump();
    expect(_burst(LiveReactionKind.thumbsUp), findsOneWidget);
    await tester.pumpAndSettle(LiveReactionsController.shown);
  });

  testWidgets(
    'a viewer who may not take part sees the strip inert and sends nothing',
    (tester) async {
      await pump(tester, _session(canJoin: false));
      await tester.tap(find.byKey(const Key('live-react-heart')));
      await tester.pump();
      expect(room.sent, isEmpty);
      expect(find.byKey(const Key('live-dock-react')), findsNothing);
      // …but still sees the room's reactions.
      realtime.emit(_frame(LiveReactionKind.heart));
      await tester.pump();
      expect(_burst(LiveReactionKind.heart), findsOneWidget);
      await tester.pumpAndSettle(LiveReactionsController.shown);
    },
  );

  testWidgets('a moderator who does not join may still react', (tester) async {
    await pump(tester, _session(canJoin: false, canModerate: true));
    await tester.tap(find.byKey(const Key('live-react-thumbs_up')));
    await tester.pump();
    expect(room.sent, ['s-1:thumbs_up']);
    await tester.pumpAndSettle(LiveReactionsController.shown);
  });

  testWidgets('a refusal is said through the server’s code', (tester) async {
    room.fail = const LiveException('live.too_many_reactions', 'x');
    await pump(tester, _session());
    await tester.tap(find.byKey(const Key('live-react-heart')));
    await tester.pump();
    await tester.pump();
    expect(
      find.text(LiveCopy.commandError('live.too_many_reactions')),
      findsOneWidget,
    );
    await tester.pumpAndSettle(LiveReactionsController.shown);
  });

  test('a frame of a kind this version does not know is dropped', () {
    expect(
      ServerFrame.parse(
        '{"type":"live.reaction","version":1,"eventId":"e","occurredAt":'
        '"2026-01-01T00:00:00.000Z","communityId":"c","sessionId":"s","kind":"fire"}',
      ),
      isNull,
    );
    final known = ServerFrame.parse(
      '{"type":"live.reaction","version":1,"eventId":"e","occurredAt":'
      '"2026-01-01T00:00:00.000Z","communityId":"c","sessionId":"s","kind":"clap"}',
    );
    expect(known, isA<LiveReactionEvent>());
    expect((known! as LiveReactionEvent).kind, LiveReactionKind.clap);
  });
}
