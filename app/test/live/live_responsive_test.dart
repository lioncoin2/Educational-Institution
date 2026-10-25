import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The live room is RTL-first and must not overflow horizontally at any
/// supported viewport, from a 320-px phone to a 1440-px desktop. A RenderFlex
/// overflow throws during layout, so a pump that completes at a width IS the
/// no-overflow assertion for that width; the extra expectations confirm the
/// stage and (for a moderator) the roster are actually laid out there.
class _Fake implements LiveRepository {
  _Fake(this.session);

  final LiveSession session;

  @override
  Future<LiveSession?> currentSession(String communityId) async => session;

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async =>
      const LiveHandsPage(items: [], nextCursor: null, origin: DataOrigin.records);

  // Nothing else is reached while rendering a running session.
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

LiveSession _session({required bool moderator}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: LiveSessionState.live,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 3,
  moderation: moderator
      ? const LiveModeration(pendingHands: 2, violations: 0)
      : null,
  me: LiveMe(
    role: moderator
        ? LiveParticipantRole.moderator
        : LiveParticipantRole.listener,
    canJoin: true,
    canModerate: moderator,
    canEnd: moderator,
    canRaiseHand: !moderator,
  ),
  origin: DataOrigin.records,
);

Future<void> pumpAt(
  WidgetTester tester,
  Size size, {
  required bool moderator,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        liveRepositoryProvider.overrideWithValue(_Fake(_session(moderator: moderator))),
        liveMediaClientProvider.overrideWithValue(const UnavailableLiveMediaClient()),
        sessionUserProvider.overrideWith((ref) async => null),
      ],
      child: MaterialApp(
        home: const LiveSessionScreen(communityId: 'c-1'),
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  const widths = <double>[320, 360, 390, 430, 768, 1024, 1280, 1440];

  for (final width in widths) {
    final w = width.toInt();

    testWidgets('listener live room: RTL, no overflow at ${w}px', (
      tester,
    ) async {
      await pumpAt(tester, Size(width, 900), moderator: false);
      expect(find.text(LiveCopy.liveNow), findsOneWidget);
      expect(
        Directionality.of(tester.element(find.text(LiveCopy.liveNow))),
        TextDirection.rtl,
      );
    });

    testWidgets('moderator live room: stage + roster, no overflow at ${w}px', (
      tester,
    ) async {
      await pumpAt(tester, Size(width, 1000), moderator: true);
      expect(find.text(LiveCopy.liveNow), findsOneWidget);
      // The roster is a side pane from tablet width up, and a sheet on a phone
      // (reached via the stage's participants button).
      if (width >= 600) {
        expect(find.text(LiveCopy.rosterSection), findsOneWidget);
      } else {
        expect(find.byKey(const Key('live-stage-participants')), findsOneWidget);
      }
    });
  }

  testWidgets('desktop (≥1024) splits the stage and the roster into two panes', (
    tester,
  ) async {
    await pumpAt(tester, const Size(1280, 900), moderator: true);
    final stageX = tester.getCenter(find.text(LiveCopy.liveNow)).dx;
    final rosterX = tester.getCenter(find.text(LiveCopy.rosterSection)).dx;
    // Side-by-side: the stage and the roster occupy different horizontal bands.
    expect((stageX - rosterX).abs(), greaterThan(100));
  });
}
