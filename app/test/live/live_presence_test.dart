import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/widgets/live_participants.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'fake_live_media_client.dart';

/// The LIVE presence roster ([LivePresenceList]) — fix #2. The names and mic
/// state are the media client's REAL view (never fabricated), and the privacy
/// gate (Q68) holds: everyone sees a connected COUNT, but only a moderator sees
/// the NAMED roster. Roles are shown only where provable (host / presenter / the
/// viewer's own role), never an invented one.
LiveSession _session({
  bool canModerate = false,
  LiveParticipantRole role = LiveParticipantRole.listener,
  List<String> presenterUserIds = const [],
}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: LiveSessionState.live,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 2,
  presenterUserIds: presenterUserIds,
  me: LiveMe(role: role, canModerate: canModerate),
);

void main() {
  /// A connected media client seeded with [remotes] (and the viewer's own mic).
  FakeLiveMediaClient connected({
    LiveRemoteParticipants? remotes,
    bool micOn = false,
  }) {
    final client = FakeLiveMediaClient(initial: const LiveMediaConnected());
    if (remotes != null) client.emitRemote(remotes);
    if (micOn) {
      client.emitPublication(const LiveMediaPublication(microphoneOn: true));
    }
    return client;
  }

  Future<void> pump(
    WidgetTester tester,
    LiveSession session,
    FakeLiveMediaClient media,
  ) async {
    addTearDown(media.dispose);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveMediaClientProvider.overrideWithValue(media),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Directionality(
              textDirection: TextDirection.rtl,
              child: SingleChildScrollView(
                child: LivePresenceList(session: session),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('shows the connected COUNT to everyone, but NAMES only to '
      'moderators (the Q68 privacy gate)', (tester) async {
    final remotes = LiveRemoteParticipants({
      'u-a': const LiveRemoteParticipant(
        identity: 'u-a',
        name: 'سارة',
        canSpeak: true,
        audio: LiveRemoteAudio.live,
      ),
      'u-b': const LiveRemoteParticipant(
        identity: 'u-b',
        name: 'ليلى',
        audio: LiveRemoteAudio.muted,
      ),
    });
    await pump(tester, _session(), connected(remotes: remotes));

    // The count (2 remotes + the viewer) is shown to a plain listener…
    expect(find.text(LiveCopy.presenceCount(3)), findsOneWidget);
    expect(find.text(LiveCopy.youLabel), findsOneWidget);
    expect(find.text(LiveCopy.presenceNamesModerators), findsOneWidget);
    // …but another participant's NAME is never exposed to a non-moderator.
    expect(find.text('سارة'), findsNothing);
    expect(find.text('ليلى'), findsNothing);
  });

  testWidgets('a moderator sees named speakers and listeners, with REAL mic '
      'state and only PROVABLE roles', (tester) async {
    final remotes = LiveRemoteParticipants({
      'u-host': const LiveRemoteParticipant(
        identity: 'u-host',
        name: 'الشيخ',
        canSpeak: true,
        audio: LiveRemoteAudio.live,
      ),
      'u-p': const LiveRemoteParticipant(
        identity: 'u-p',
        name: 'المقدّم',
        canSpeak: true,
        audio: LiveRemoteAudio.live,
      ),
      'u-s': const LiveRemoteParticipant(
        identity: 'u-s',
        name: 'عبدالله',
        canSpeak: true,
        audio: LiveRemoteAudio.live,
      ),
      'u-l': const LiveRemoteParticipant(
        identity: 'u-l',
        name: 'حسن',
        audio: LiveRemoteAudio.muted,
      ),
    });
    await pump(
      tester,
      _session(
        canModerate: true,
        role: LiveParticipantRole.moderator,
        presenterUserIds: ['u-p'],
      ),
      connected(remotes: remotes),
    );

    // Names ARE shown to a moderator, grouped into the two provable sections.
    expect(find.text('الشيخ'), findsOneWidget);
    expect(find.text('عبدالله'), findsOneWidget);
    expect(find.text('حسن'), findsOneWidget);
    expect(find.text(LiveCopy.sectionSpeakers), findsOneWidget);
    expect(find.text(LiveCopy.sectionListeners), findsOneWidget);
    expect(find.text(LiveCopy.presenceNamesModerators), findsNothing);

    // Provable roles only: host + presenter carry a chip…
    expect(find.text(LiveCopy.roleHost), findsOneWidget);
    expect(find.text(LiveCopy.presenterBadge), findsOneWidget);
    // …and a remote row is NEVER labelled with an invented speaker/listener
    // role (those words are reserved for the viewer's own row).
    expect(find.text(LiveCopy.roleSpeaker), findsNothing);
    expect(find.text(LiveCopy.roleListener), findsNothing);

    // Mic state is the SDK's real view: a live publication shows the on icon, a
    // muted one the off icon.
    expect(find.byIcon(Icons.mic_rounded), findsWidgets);
    expect(find.byIcon(Icons.mic_off_rounded), findsWidgets);
  });

  testWidgets('when NOT connected it shows a join prompt and no names or '
      'presence', (tester) async {
    // Idle client: LiveKit has no roster until the viewer joins the audio.
    await pump(
      tester,
      _session(canModerate: true, role: LiveParticipantRole.moderator),
      FakeLiveMediaClient(),
    );
    expect(find.text(LiveCopy.presenceJoinToSee), findsOneWidget);
    expect(find.text(LiveCopy.presenceCount(0)), findsOneWidget);
    expect(find.text(LiveCopy.youLabel), findsNothing);
  });
}
