import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/features/live/widgets/live_states.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

class _FakeLive implements LiveRepository {
  _FakeLive(this._answer);

  final Future<LiveSession?> Function(String communityId) _answer;

  @override
  Future<LiveSession?> currentSession(String communityId) =>
      _answer(communityId);
}

LiveSession _session({
  DataOrigin origin = DataOrigin.records,
  bool host = false,
}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: LiveSessionState.live,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 2,
  me: LiveMe(
    role: host ? LiveParticipantRole.moderator : LiveParticipantRole.listener,
    isHost: host,
    canModerate: host,
  ),
  origin: origin,
);

void main() {
  Future<void> pump(
    WidgetTester tester,
    LiveRepository repo, {
    LiveMediaClient media = const UnavailableLiveMediaClient(),
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(repo),
          liveMediaClientProvider.overrideWithValue(media),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(home: LiveSessionScreen(communityId: 'c-1')),
      ),
    );
  }

  testWidgets('shows a skeleton while loading, then the running session', (
    tester,
  ) async {
    final hold = Completer<LiveSession?>();
    await pump(tester, _FakeLive((_) => hold.future));
    await tester.pump();
    expect(find.byType(LiveSkeleton), findsOneWidget);

    hold.complete(_session());
    await tester.pumpAndSettle();
    expect(find.text(LiveCopy.liveNow), findsOneWidget);
    expect(find.text(LiveCopy.speakers(2)), findsOneWidget);
  });

  testWidgets('says plainly that live audio is unavailable in this build', (
    tester,
  ) async {
    await pump(tester, _FakeLive((_) async => _session()));
    await tester.pumpAndSettle();
    expect(find.text(LiveCopy.audioUnavailable), findsOneWidget);
    // Never implies joining/voice works.
    expect(find.widgetWithText(FilledButton, LiveCopy.liveNow), findsNothing);
  });

  testWidgets('shows the empty state when no session is running', (
    tester,
  ) async {
    await pump(tester, _FakeLive((_) async => null));
    await tester.pumpAndSettle();
    expect(find.text(LiveCopy.noSession), findsOneWidget);
    expect(find.text(LiveCopy.liveNow), findsNothing);
  });

  testWidgets('explains a failure and offers a retry', (tester) async {
    await pump(
      tester,
      _FakeLive((_) async => throw const LiveException('unavailable', 'no')),
    );
    await tester.pumpAndSettle();
    expect(find.text(LiveCopy.error('unavailable')), findsOneWidget);
    expect(find.text(LiveCopy.retry), findsOneWidget);
  });

  testWidgets('flags a demo session as mock data', (tester) async {
    await pump(
      tester,
      _FakeLive((_) async => _session(origin: DataOrigin.mock)),
    );
    await tester.pumpAndSettle();
    expect(find.byType(MockBanner), findsOneWidget);
  });

  testWidgets('tells the host they host the session', (tester) async {
    await pump(tester, _FakeLive((_) async => _session(host: true)));
    await tester.pumpAndSettle();
    expect(find.text(LiveCopy.youHost), findsOneWidget);
  });
}
