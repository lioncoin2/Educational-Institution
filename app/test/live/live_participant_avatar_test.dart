import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/core/widgets/foundations/app_avatar.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/models/live_room.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'fake_live_media_client.dart';

/// C15 issue 1 — the live room shows each participant's real profile picture
/// wherever it shows who they are: the presence rows, the moderator roster,
/// the viewer's own row, and the host — the teacher — at the centre of the
/// stage. The picture comes from the one source every surface uses (identity's
/// reference, a Files link, asked of the session); with none, initials; a
/// shared screen keeps the stage. One read per person per session.
class _FakeLive implements LiveRepository {
  _FakeLive(this.session);

  LiveSession session;

  @override
  Future<LiveSession?> currentSession(String communityId) async => session;

  @override
  Future<LiveSession> getSession(String sessionId) async => session;

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async => LiveHandsPage(
    items: [
      LiveHand(
        id: 'h-1',
        sessionId: 's-1',
        userId: 'u-student',
        state: SpeakerRequestState.pending,
        requestedAt: DateTime.utc(2026),
        displayName: 'مريم',
      ),
    ],
    nextCursor: null,
    origin: DataOrigin.records,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

class _FakeRoom implements LiveRoomRepository {
  _FakeRoom(this.pictures);

  final Map<String, Uri> pictures;
  final List<String> asked = [];
  Object? fail;
  Completer<void>? hold;

  @override
  Future<Uri?> participantAvatarUrl(String sessionId, String userId) async {
    asked.add(userId);
    if (hold != null) await hold!.future;
    if (fail != null) throw fail!;
    return pictures[userId];
  }

  @override
  Future<void> react(String sessionId, LiveReactionKind kind) async {}
}

LiveSession _session({bool moderator = false, int version = 1}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: LiveSessionState.live,
  stateVersion: version,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 1,
  me: LiveMe(
    role: moderator
        ? LiveParticipantRole.moderator
        : LiveParticipantRole.listener,
    canJoin: true,
    canModerate: moderator,
    canEnd: moderator,
  ),
);

final _hostPicture = Uri.parse('https://files.test/host.png');
final _studentPicture = Uri.parse('https://files.test/student.png');
final _ownPicture = Uri.parse('https://files.test/me.png');

const _me = CurrentUser(
  id: 'u-me',
  displayName: 'سلمى',
  status: AccountStatus.active,
  roles: ['STUDENT'],
  permissions: {},
);

void main() {
  late FakeRealtimeClient realtime;
  late FakeLiveMediaClient media;

  setUp(() {
    realtime = FakeRealtimeClient();
    media = FakeLiveMediaClient(initial: const LiveMediaConnected())
      ..emitRemote(
        const LiveRemoteParticipants({
          'u-host': LiveRemoteParticipant(
            identity: 'u-host',
            name: 'الأستاذة حفصة',
            canSpeak: true,
            audio: LiveRemoteAudio.live,
          ),
          'u-student': LiveRemoteParticipant(
            identity: 'u-student',
            name: 'مريم',
          ),
        }),
      );
  });

  Future<(_FakeLive, _FakeRoom)> pump(
    WidgetTester tester, {
    required LiveSession session,
    _FakeRoom? room,
  }) async {
    final live = _FakeLive(session);
    final rooms =
        room ??
        _FakeRoom({'u-host': _hostPicture, 'u-student': _studentPicture});
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(live),
          liveRoomRepositoryProvider.overrideWithValue(rooms),
          liveMediaClientProvider.overrideWithValue(media),
          realtimeConnectionProvider.overrideWithValue(realtime),
          sessionUserProvider.overrideWith((ref) async => _me),
          ownAvatarUrlProvider.overrideWith((ref) async => _ownPicture),
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
    return (live, rooms);
  }

  AppAvatar avatarOf(WidgetTester tester, String userId) =>
      tester.widget<AppAvatar>(find.byKey(Key('live-avatar-$userId')).first);

  testWidgets(
    'a moderator sees each participant’s real picture in the presence list and roster',
    (tester) async {
      await pump(tester, session: _session(moderator: true));
      expect(avatarOf(tester, 'u-host').imageUrl, _hostPicture);
      // The student appears in the presence list AND the hands roster: both rows
      // show the picture, from one read.
      expect(find.byKey(const Key('live-avatar-u-student')), findsNWidgets(2));
      expect(avatarOf(tester, 'u-student').imageUrl, _studentPicture);
    },
  );

  testWidgets(
    'the viewer’s own row shows their own picture and their own initial',
    (tester) async {
      final (_, rooms) = await pump(tester, session: _session());
      final self = avatarOf(tester, 'u-me');
      expect(self.imageUrl, _ownPicture);
      expect(self.name, 'سلمى');
      // Their own picture comes from their account — never asked of the session.
      expect(rooms.asked, isNot(contains('u-me')));
    },
  );

  testWidgets('the teacher — the host — is on the stage by their picture', (
    tester,
  ) async {
    await pump(tester, session: _session());
    expect(find.byKey(const Key('live-stage-host-avatar')), findsOneWidget);
    expect(avatarOf(tester, 'u-host').imageUrl, _hostPicture);
    expect(avatarOf(tester, 'u-host').name, 'الأستاذة حفصة');
  });

  testWidgets(
    'no picture: initials in the rows, and the broadcast glyph on the stage',
    (tester) async {
      await pump(
        tester,
        session: _session(moderator: true),
        room: _FakeRoom({}),
      );
      expect(avatarOf(tester, 'u-student').imageUrl, isNull);
      expect(avatarOf(tester, 'u-student').name, 'مريم');
      expect(find.byKey(const Key('live-stage-host-avatar')), findsNothing);
      expect(find.byIcon(Icons.graphic_eq_rounded), findsWidgets);
    },
  );

  testWidgets('a failed read degrades to initials — never an error on screen', (
    tester,
  ) async {
    final room = _FakeRoom({'u-host': _hostPicture})
      ..fail = const LiveException('unavailable', 'x');
    await pump(tester, session: _session(moderator: true), room: room);
    expect(avatarOf(tester, 'u-host').imageUrl, isNull);
    expect(find.byKey(const Key('live-stage-host-avatar')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'while the link loads the initials hold the place — no layout shift',
    (tester) async {
      final room = _FakeRoom({'u-student': _studentPicture})
        ..hold = Completer();
      await pump(tester, session: _session(moderator: true), room: room);
      final before = tester.getSize(
        find.byKey(const Key('live-avatar-u-student')).first,
      );
      expect(avatarOf(tester, 'u-student').imageUrl, isNull);
      room.hold!.complete();
      await tester.pumpAndSettle();
      expect(avatarOf(tester, 'u-student').imageUrl, _studentPicture);
      expect(
        tester.getSize(find.byKey(const Key('live-avatar-u-student')).first),
        before,
      );
    },
  );

  testWidgets(
    'a shared screen keeps the stage: the live feed is never replaced by a picture',
    (tester) async {
      media.emitRemote(
        const LiveRemoteParticipants({
          'u-host': LiveRemoteParticipant(
            identity: 'u-host',
            name: 'الأستاذة حفصة',
            canSpeak: true,
            screenSharing: true,
          ),
        }),
      );
      await pump(tester, session: _session());
      expect(find.byKey(const Key('live-screen-share')), findsOneWidget);
      expect(find.byKey(const Key('live-stage-host-avatar')), findsNothing);
    },
  );

  testWidgets(
    'one read per person per session — realtime re-reads and reconnects ask nothing again',
    (tester) async {
      final (live, rooms) = await pump(
        tester,
        session: _session(moderator: true),
      );
      final first = List.of(rooms.asked);
      expect(first.where((id) => id == 'u-host'), hasLength(1));
      expect(first.where((id) => id == 'u-student'), hasLength(1));

      live.session = _session(moderator: true, version: 2);
      realtime.emit(
        LiveSessionChangedEvent(
          eventId: 'live.session.changed:s-1:2',
          occurredAt: DateTime.utc(2026),
          communityId: 'c-1',
          sessionId: 's-1',
          stateVersion: 2,
        ),
      );
      await tester.pumpAndSettle();
      media.emit(const LiveMediaReconnecting());
      await tester.pumpAndSettle();
      media.emit(const LiveMediaConnected());
      await tester.pumpAndSettle();
      expect(rooms.asked, first);
      expect(avatarOf(tester, 'u-student').imageUrl, _studentPicture);
    },
  );
}
