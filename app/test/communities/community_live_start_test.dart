import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// Starting a live session from the community screen (owner decision: the app
/// can now start one, not only join). The entry is shown only when the server's
/// `me` holds `community.live.start`; the start goes to the existing backend
/// route and the server re-authorises. On success the live room opens; a
/// refusal (e.g. the media room cannot be made) is said in words and nothing
/// opens.
class _FakeLive implements LiveRepository {
  _FakeLive({this.failWith});

  /// When set, every start is refused with this code.
  final String? failWith;
  final List<String> started = [];

  @override
  Future<LiveSession> start(String communityId) async {
    started.add(communityId);
    final code = failWith;
    if (code != null) throw LiveException(code, code);
    return LiveSession(
      id: 'session-$communityId',
      communityId: communityId,
      state: LiveSessionState.live,
      hostUserId: 'host',
      startedAt: DateTime.utc(2026),
      speakerCount: 0,
      me: const LiveMe(role: LiveParticipantRole.moderator, isHost: true),
      origin: DataOrigin.records,
    );
  }

  // The live room the start opens reads this; null keeps that screen's render
  // trivial (its own behaviour is tested in the live suite). The button's job
  // is only to start and navigate.
  @override
  Future<LiveSession?> currentSession(String communityId) async => null;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

void main() {
  const id = 'c-live-1';
  final startButton = find.byKey(const Key('community-start-live'));

  List<Override> overrides(
    CommunityRepository community,
    LiveRepository live,
  ) => [
    communityRepositoryProvider.overrideWithValue(community),
    liveRepositoryProvider.overrideWithValue(live),
    realtimeConnectionProvider.overrideWithValue(
      const DisabledRealtimeClient(),
    ),
    sessionUserProvider.overrideWith((ref) async => null),
  ];

  AnsweredAs communityWith(List<String> capabilities) => AnsweredAs(
    communityJson(id: id, standing: 'OWNER', capabilities: capabilities),
  );

  testWidgets('shows Start live to a holder of community.live.start', (
    tester,
  ) async {
    await openApp(
      tester,
      '/communities/$id',
      overrides: overrides(
        communityWith(['community.live.start']),
        _FakeLive(),
      ),
    );
    expect(startButton, findsOneWidget);
  });

  testWidgets('hides Start live from anyone without it', (tester) async {
    await openApp(
      tester,
      '/communities/$id',
      overrides: overrides(communityWith(const []), _FakeLive()),
    );
    expect(startButton, findsNothing);
  });

  testWidgets('starting asks the server and opens the live room', (
    tester,
  ) async {
    final live = _FakeLive();
    final container = await openApp(
      tester,
      '/communities/$id',
      overrides: overrides(communityWith(['community.live.start']), live),
    );

    await tester.tap(startButton);
    await tester.pumpAndSettle();

    expect(live.started, [id]);
    expect(locationIn(container), endsWith('/live')); // opened the live room
  });

  testWidgets('a refused start is said in words, and nothing opens', (
    tester,
  ) async {
    final live = _FakeLive(failWith: 'live.media_unavailable');
    final container = await openApp(
      tester,
      '/communities/$id',
      overrides: overrides(communityWith(['community.live.start']), live),
    );

    await tester.tap(startButton);
    await tester.pumpAndSettle();

    expect(live.started, [id]);
    expect(
      find.text(CommunityCopy.liveStartFailed('live.media_unavailable')),
      findsOneWidget,
    );
    expect(locationIn(container), '/communities/$id'); // did not navigate
  });
}
