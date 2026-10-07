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

/// A repository the screen drives: it answers the current session, records
/// every moderator command it is asked to run, and can hold a command in
/// flight or make it fail — so command UX (progress, no duplicate, error,
/// success, no optimistic mutation) can be asserted. Its command RESULTS are
/// never applied by the UI, which is the point.
class _FakeLive implements LiveRepository {
  _FakeLive(this._answer);

  final Future<LiveSession?> Function(String communityId) _answer;

  final List<String> calls = [];
  Object? commandError;
  Completer<void>? hold;

  Future<T> _run<T>(String label, T result) async {
    calls.add(label);
    if (hold != null) await hold!.future;
    if (commandError != null) throw commandError!;
    return result;
  }

  @override
  Future<LiveSession?> currentSession(String communityId) =>
      _answer(communityId);

  @override
  Future<LiveSession> endSession(String sessionId) =>
      _run('endSession:$sessionId', _session(state: LiveSessionState.ended));

  @override
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  }) => _run('removeParticipant:$sessionId:$userId', true);

  @override
  Future<bool> resetRoom(String sessionId) =>
      _run('resetRoom:$sessionId', true);

  @override
  Future<LiveSession> claimPresenter(String sessionId) =>
      _run('claimPresenter:$sessionId', _session(presenting: true));

  @override
  Future<LiveSession> stopPresenter(String sessionId) =>
      _run('stopPresenter:$sessionId', _session());

  @override
  Future<LiveSession> grantPresenter(String sessionId, String userId) =>
      _run('grantPresenter:$sessionId:$userId', _session());

  @override
  Future<LiveSession> revokePresenter(String sessionId, String userId) =>
      _run('revokePresenter:$sessionId:$userId', _session());

  @override
  Future<LiveSession> getSession(String sessionId) =>
      throw UnimplementedError();

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) => throw UnimplementedError();
}

LiveSession _session({
  DataOrigin origin = DataOrigin.records,
  LiveSessionState state = LiveSessionState.live,
  bool isHost = false,
  bool canModerate = false,
  bool canEnd = false,
  bool canPresent = false,
  bool presenting = false,
  LiveModeration? moderation,
}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: state,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 2,
  moderation: moderation,
  me: LiveMe(
    role: canModerate || isHost
        ? LiveParticipantRole.moderator
        : LiveParticipantRole.listener,
    isHost: isHost,
    canModerate: canModerate,
    canEnd: canEnd,
    canPresent: canPresent,
    presenting: presenting,
  ),
  origin: origin,
);

void main() {
  Future<_FakeLive> pump(
    WidgetTester tester,
    _FakeLive repo, {
    LiveMediaClient media = const UnavailableLiveMediaClient(),
    TextDirection direction = TextDirection.rtl,
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(repo),
          liveMediaClientProvider.overrideWithValue(media),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: MaterialApp(
          home: const LiveSessionScreen(communityId: 'c-1'),
          builder: (context, child) =>
              Directionality(textDirection: direction, child: child!),
        ),
      ),
    );
    return repo;
  }

  _FakeLive fake([LiveSession? session]) =>
      _FakeLive((_) async => session ?? _session());

  group('session states', () {
    testWidgets('skeleton while loading, then the running session', (
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
      await pump(tester, fake());
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.audioUnavailable), findsOneWidget);
    });

    testWidgets('empty state when no session is running', (tester) async {
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

    testWidgets('an ended session shows the ended card and no controls', (
      tester,
    ) async {
      await pump(
        tester,
        fake(_session(state: LiveSessionState.ended, canEnd: true)),
      );
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.sessionEnded), findsOneWidget);
      expect(find.text(LiveCopy.liveNow), findsNothing);
      // No stale active controls, even though the stale `me` still says canEnd.
      expect(find.byKey(const Key('live-end-session')), findsNothing);
      expect(find.text(LiveCopy.audioUnavailable), findsNothing);
    });

    testWidgets('flags a demo session as mock data', (tester) async {
      await pump(tester, fake(_session(origin: DataOrigin.mock)));
      await tester.pumpAndSettle();
      expect(find.byType(MockBanner), findsOneWidget);
    });
  });

  group('capability-gated controls (backend me.* only)', () {
    testWidgets('a plain listener sees no moderator controls', (tester) async {
      await pump(tester, fake(_session()));
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.controlsSection), findsNothing);
      expect(find.byKey(const Key('live-end-session')), findsNothing);
      expect(find.byKey(const Key('live-reset-room')), findsNothing);
      expect(find.byKey(const Key('live-claim-presenter')), findsNothing);
    });

    testWidgets('canEnd shows/hides the end control', (tester) async {
      await pump(tester, fake(_session(canEnd: true)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-end-session')), findsOneWidget);
      expect(find.text(LiveCopy.endSession), findsOneWidget);
    });

    testWidgets('canModerate shows the reset control and pending count', (
      tester,
    ) async {
      await pump(
        tester,
        fake(
          _session(
            canModerate: true,
            moderation: const LiveModeration(pendingHands: 3, violations: 0),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-reset-room')), findsOneWidget);
      expect(find.text(LiveCopy.pendingHands(3)), findsOneWidget);
    });

    testWidgets('canPresent (not presenting) shows claim, not stop', (
      tester,
    ) async {
      await pump(tester, fake(_session(canPresent: true)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-claim-presenter')), findsOneWidget);
      expect(find.byKey(const Key('live-stop-presenter')), findsNothing);
    });

    testWidgets('presenting shows stop and the "you present" note', (
      tester,
    ) async {
      await pump(tester, fake(_session(presenting: true)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-stop-presenter')), findsOneWidget);
      expect(find.byKey(const Key('live-claim-presenter')), findsNothing);
      expect(find.text(LiveCopy.youPresent), findsOneWidget);
    });

    testWidgets('tells the host they host the session', (tester) async {
      await pump(tester, fake(_session(isHost: true)));
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.youHost), findsOneWidget);
    });
  });

  group('commands', () {
    testWidgets('end: confirms, then invokes endSession and says done', (
      tester,
    ) async {
      final repo = await pump(tester, fake(_session(canEnd: true)));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('live-end-session')));
      await tester.pumpAndSettle();
      // The confirmation — nothing is sent until an explicit yes.
      expect(find.text(LiveCopy.endSessionQuestion), findsOneWidget);
      expect(repo.calls, isEmpty);

      await tester.tap(find.text(LiveCopy.endSessionConfirm));
      await tester.pumpAndSettle();
      expect(repo.calls, ['endSession:s-1']);
      expect(find.text(LiveCopy.endSessionDone), findsOneWidget);
    });

    testWidgets('end: dismissing the confirmation sends nothing', (
      tester,
    ) async {
      final repo = await pump(tester, fake(_session(canEnd: true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-end-session')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(LiveCopy.cancel));
      await tester.pumpAndSettle();
      expect(repo.calls, isEmpty);
    });

    testWidgets('reset: confirms then invokes resetRoom', (tester) async {
      final repo = await pump(tester, fake(_session(canModerate: true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-reset-room')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(LiveCopy.resetRoomConfirm));
      await tester.pumpAndSettle();
      expect(repo.calls, ['resetRoom:s-1']);
      expect(find.text(LiveCopy.resetRoomDone), findsOneWidget);
    });

    testWidgets('claim presenter: no confirm, invokes claimPresenter', (
      tester,
    ) async {
      final repo = await pump(tester, fake(_session(canPresent: true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-claim-presenter')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['claimPresenter:s-1']);
      expect(find.text(LiveCopy.claimPresenterDone), findsOneWidget);
    });

    testWidgets('shows progress and blocks a duplicate while in flight', (
      tester,
    ) async {
      final repo = fake(_session(canPresent: true));
      repo.hold = Completer<void>();
      await pump(tester, repo);
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('live-claim-presenter')));
      await tester.pump();
      // In flight: a spinner, and the label kept.
      expect(
        find.descendant(
          of: find.byKey(const Key('live-claim-presenter')),
          matching: find.byType(CircularProgressIndicator),
        ),
        findsOneWidget,
      );
      expect(find.text(LiveCopy.claimPresenter), findsOneWidget);

      // A second tap while busy sends nothing (the button is disabled).
      await tester.tap(find.byKey(const Key('live-claim-presenter')));
      await tester.pump();
      expect(repo.calls, ['claimPresenter:s-1']);

      repo.hold!.complete();
      await tester.pumpAndSettle();
      expect(repo.calls, ['claimPresenter:s-1']);
    });

    testWidgets('a refusal is said through the server’s code', (tester) async {
      final repo = fake(_session(canPresent: true))
        ..commandError = const LiveException('live.presenter_slots_full', 'x');
      await pump(tester, repo);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-claim-presenter')));
      await tester.pumpAndSettle();
      expect(
        find.text(LiveCopy.commandError('live.presenter_slots_full')),
        findsOneWidget,
      );
    });
  });

  group('no optimistic mutation', () {
    testWidgets('a successful end does not fabricate the ended state', (
      tester,
    ) async {
      final repo = await pump(tester, fake(_session(canEnd: true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-end-session')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(LiveCopy.endSessionConfirm));
      await tester.pumpAndSettle();

      expect(repo.calls, ['endSession:s-1']);
      // The command returned an ended session, but the screen must NOT apply
      // it — only realtime reconciliation (Slice 4) changes the view.
      expect(find.text(LiveCopy.liveNow), findsOneWidget);
      expect(find.text(LiveCopy.sessionEnded), findsNothing);
    });

    testWidgets('a successful claim does not fabricate presenter state', (
      tester,
    ) async {
      final repo = await pump(tester, fake(_session(canPresent: true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-claim-presenter')));
      await tester.pumpAndSettle();

      expect(repo.calls, ['claimPresenter:s-1']);
      // presenting stayed false locally — the claim button is still shown,
      // the "you present" note is not fabricated.
      expect(find.byKey(const Key('live-claim-presenter')), findsOneWidget);
      expect(find.text(LiveCopy.youPresent), findsNothing);
    });
  });

  group('layout & accessibility', () {
    testWidgets('renders all controls RTL on a narrow phone with no overflow', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(360, 690);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await pump(
        tester,
        fake(_session(isHost: true, canModerate: true, canEnd: true)),
      );
      await tester.pumpAndSettle();

      expect(
        Directionality.of(tester.element(find.text(LiveCopy.liveNow))),
        TextDirection.rtl,
      );
      expect(find.byKey(const Key('live-end-session')), findsOneWidget);
      expect(find.byKey(const Key('live-reset-room')), findsOneWidget);
      // A RenderFlex overflow would have thrown during the pump above.
    });

    testWidgets('the destructive end control is named, not icon-only', (
      tester,
    ) async {
      await pump(tester, fake(_session(canEnd: true)));
      await tester.pumpAndSettle();
      // The label text is the control's accessible name.
      expect(
        find.descendant(
          of: find.byKey(const Key('live-end-session')),
          matching: find.text(LiveCopy.endSession),
        ),
        findsOneWidget,
      );
    });
  });
}
