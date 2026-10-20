import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/features/live/widgets/live_states.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'fake_live_media_client.dart';

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

  /// The roster read is independent of the command machinery above: it records
  /// how it was queried and answers a fixed page (empty by default).
  final List<String> handsCalls = [];
  LiveHandsPage handsResult = const LiveHandsPage(
    items: [],
    nextCursor: null,
    origin: DataOrigin.records,
  );
  Object? handsError;

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
  Future<LiveHand> raiseHand(String sessionId) =>
      _run('raiseHand:$sessionId', _hand(id: 'h-self', userId: 'u-self'));

  @override
  Future<LiveHand?> lowerHand(String sessionId) => _run(
    'lowerHand:$sessionId',
    _hand(
      id: 'h-self',
      userId: 'u-self',
      state: SpeakerRequestState.withdrawn,
    ),
  );

  @override
  Future<LiveHand> grantFloor(String requestId) => _run(
    'grantFloor:$requestId',
    _hand(
      id: requestId,
      userId: 'u-1',
      state: SpeakerRequestState.granted,
    ),
  );

  @override
  Future<LiveHand> declineHand(String requestId) => _run(
    'declineHand:$requestId',
    _hand(
      id: requestId,
      userId: 'u-1',
      state: SpeakerRequestState.declined,
    ),
  );

  @override
  Future<LiveHand> revokeFloor(String requestId) => _run(
    'revokeFloor:$requestId',
    _hand(
      id: requestId,
      userId: 'u-1',
      state: SpeakerRequestState.revoked,
    ),
  );

  @override
  Future<LiveSession> start(String communityId) => throw UnimplementedError();

  @override
  Future<LiveSession> getSession(String sessionId) =>
      throw UnimplementedError();

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async {
    handsCalls.add('hands:$sessionId:${state?.wire}:$cursor');
    if (handsError != null) throw handsError!;
    return handsResult;
  }

  @override
  Future<LiveMediaGrant> join(String sessionId) => throw UnimplementedError();
}

/// One hand on the roster, for the moderator-roster tests.
LiveHand _hand({
  required String id,
  required String userId,
  SpeakerRequestState state = SpeakerRequestState.pending,
  String? displayName,
  LiveObservedMedia? media,
}) => LiveHand(
  id: id,
  sessionId: 's-1',
  userId: userId,
  state: state,
  requestedAt: DateTime.utc(2026),
  grantedAt: state == SpeakerRequestState.granted ? DateTime.utc(2026) : null,
  displayName: displayName,
  media: media,
);

LiveSession _session({
  DataOrigin origin = DataOrigin.records,
  LiveSessionState state = LiveSessionState.live,
  bool isHost = false,
  bool canJoin = false,
  bool canModerate = false,
  bool canEnd = false,
  bool canPresent = false,
  bool presenting = false,
  bool canRaiseHand = false,
  LiveMyHand? hand,
  LiveModeration? moderation,
  List<String> presenterUserIds = const [],
}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: state,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 2,
  moderation: moderation,
  presenterUserIds: presenterUserIds,
  me: LiveMe(
    role: canModerate || isHost
        ? LiveParticipantRole.moderator
        : LiveParticipantRole.listener,
    isHost: isHost,
    canJoin: canJoin,
    canModerate: canModerate,
    canEnd: canEnd,
    canPresent: canPresent,
    presenting: presenting,
    canRaiseHand: canRaiseHand,
    hand: hand,
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

  group('the viewer’s hand (raise / lower / yield)', () {
    testWidgets('canRaiseHand shows the raise control, not a lower', (
      tester,
    ) async {
      await pump(tester, fake(_session(canRaiseHand: true)));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-raise-hand')), findsOneWidget);
      expect(find.byKey(const Key('live-lower-hand')), findsNothing);
      expect(find.text(LiveCopy.raiseHand), findsOneWidget);
    });

    testWidgets('a listener with neither a hand nor canRaiseHand sees nothing', (
      tester,
    ) async {
      await pump(tester, fake(_session()));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-raise-hand')), findsNothing);
      expect(find.byKey(const Key('live-lower-hand')), findsNothing);
      expect(find.text(LiveCopy.handSection), findsNothing);
    });

    testWidgets('raise: invokes raiseHand and says done', (tester) async {
      final repo = await pump(tester, fake(_session(canRaiseHand: true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-raise-hand')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['raiseHand:s-1']);
      expect(find.text(LiveCopy.raiseHandDone), findsOneWidget);
    });

    testWidgets('a pending hand shows its status and the lower control', (
      tester,
    ) async {
      await pump(
        tester,
        fake(
          _session(
            hand: const LiveMyHand(
              requestId: 'r-1',
              state: SpeakerRequestState.pending,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.handStatusPending), findsOneWidget);
      expect(find.byKey(const Key('live-lower-hand')), findsOneWidget);
      expect(find.byKey(const Key('live-raise-hand')), findsNothing);
      expect(find.text(LiveCopy.lowerHand), findsOneWidget);
    });

    testWidgets('lower: invokes lowerHand', (tester) async {
      final repo = await pump(
        tester,
        fake(
          _session(
            hand: const LiveMyHand(
              requestId: 'r-1',
              state: SpeakerRequestState.pending,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-lower-hand')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['lowerHand:s-1']);
      expect(find.text(LiveCopy.lowerHandDone), findsOneWidget);
    });

    testWidgets('a granted hand shows the floor status and the yield control', (
      tester,
    ) async {
      await pump(
        tester,
        fake(
          _session(
            hand: const LiveMyHand(
              requestId: 'r-1',
              state: SpeakerRequestState.granted,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.handStatusGranted), findsOneWidget);
      expect(find.text(LiveCopy.yieldFloor), findsOneWidget);
      expect(find.byKey(const Key('live-lower-hand')), findsOneWidget);
    });

    testWidgets('a refusal is said through the server’s code', (tester) async {
      final repo = fake(_session(canRaiseHand: true))
        ..commandError = const LiveException('live.session_not_live', 'x');
      await pump(tester, repo);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-raise-hand')));
      await tester.pumpAndSettle();
      expect(
        find.text(LiveCopy.commandError('live.session_not_live')),
        findsOneWidget,
      );
    });

    testWidgets('a successful raise does not fabricate the hand locally', (
      tester,
    ) async {
      // The command returns a pending hand, but the screen must NOT apply it —
      // only reconciliation changes `me`. The raise control therefore stays.
      final repo = await pump(tester, fake(_session(canRaiseHand: true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-raise-hand')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['raiseHand:s-1']);
      expect(find.byKey(const Key('live-raise-hand')), findsOneWidget);
      expect(find.text(LiveCopy.handStatusPending), findsNothing);
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

  group('moderator roster (Q56/Q64)', () {
    testWidgets('a plain listener sees no roster', (tester) async {
      await pump(tester, fake(_session()));
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.rosterSection), findsNothing);
    });

    testWidgets('a moderator with no hands sees the roster and its empty state', (
      tester,
    ) async {
      await pump(tester, fake(_session(canModerate: true)));
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.rosterSection), findsOneWidget);
      expect(find.text(LiveCopy.rosterEmpty), findsOneWidget);
    });

    testWidgets('lists each hand by name, with a neutral fallback for none', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [
            _hand(id: 'h1', userId: 'u-1', displayName: 'سارة'),
            _hand(id: 'h2', userId: 'u-2'),
          ],
          nextCursor: null,
        );
      await pump(tester, repo);
      await tester.pumpAndSettle();
      expect(find.text('سارة'), findsOneWidget);
      expect(find.text(LiveCopy.participantFallback), findsOneWidget);
    });

    testWidgets('remove: confirms, then removes that participant by id', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [_hand(id: 'h1', userId: 'u-1', displayName: 'سارة')],
          nextCursor: null,
        );
      await pump(tester, repo);
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.byKey(const Key('live-remove-u-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-remove-u-1')));
      await tester.pumpAndSettle();
      // Nothing is sent until an explicit yes.
      expect(find.text(LiveCopy.removeParticipantQuestion), findsOneWidget);
      expect(repo.calls, isEmpty);

      await tester.tap(find.text(LiveCopy.removeParticipantConfirm));
      await tester.pumpAndSettle();
      expect(repo.calls, ['removeParticipant:s-1:u-1']);
      expect(find.text(LiveCopy.removeParticipantDone), findsOneWidget);
    });

    testWidgets('grant presenter: a non-presenter row grants, by id', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [_hand(id: 'h1', userId: 'u-1')],
          nextCursor: null,
        );
      await pump(tester, repo);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-grant-presenter-u-1')), findsOneWidget);
      expect(find.byKey(const Key('live-revoke-presenter-u-1')), findsNothing);

      await tester.ensureVisible(
        find.byKey(const Key('live-grant-presenter-u-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-grant-presenter-u-1')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['grantPresenter:s-1:u-1']);
      expect(find.text(LiveCopy.grantPresenterDone), findsOneWidget);
    });

    testWidgets('revoke presenter: a current presenter row revokes, by id', (
      tester,
    ) async {
      final repo =
          fake(_session(canModerate: true, presenterUserIds: const ['u-1']))
            ..handsResult = LiveHandsPage(
              items: [
                _hand(
                  id: 'h1',
                  userId: 'u-1',
                  state: SpeakerRequestState.granted,
                  media: LiveObservedMedia.connected,
                ),
              ],
              nextCursor: null,
            );
      await pump(tester, repo);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-revoke-presenter-u-1')), findsOneWidget);
      expect(find.byKey(const Key('live-grant-presenter-u-1')), findsNothing);
      expect(find.text(LiveCopy.presenterBadge), findsOneWidget);

      await tester.ensureVisible(
        find.byKey(const Key('live-revoke-presenter-u-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-revoke-presenter-u-1')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['revokePresenter:s-1:u-1']);
      expect(find.text(LiveCopy.revokePresenterDone), findsOneWidget);
    });

    testWidgets('a pending hand offers grant and decline, by request id', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [_hand(id: 'h1', userId: 'u-1')],
          nextCursor: null,
        );
      await pump(tester, repo);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-grant-floor-h1')), findsOneWidget);
      expect(find.byKey(const Key('live-decline-hand-h1')), findsOneWidget);
      expect(find.byKey(const Key('live-revoke-floor-h1')), findsNothing);

      await tester.ensureVisible(find.byKey(const Key('live-grant-floor-h1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-grant-floor-h1')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['grantFloor:h1']);
      expect(find.text(LiveCopy.grantFloorDone), findsOneWidget);
    });

    testWidgets('decline a pending hand, by request id', (tester) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [_hand(id: 'h1', userId: 'u-1')],
          nextCursor: null,
        );
      await pump(tester, repo);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('live-decline-hand-h1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-decline-hand-h1')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['declineHand:h1']);
      expect(find.text(LiveCopy.declineHandDone), findsOneWidget);
    });

    testWidgets('a granted hand offers revoke the floor, by request id', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [
            _hand(id: 'h9', userId: 'u-1', state: SpeakerRequestState.granted),
          ],
          nextCursor: null,
        );
      await pump(tester, repo);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-revoke-floor-h9')), findsOneWidget);
      expect(find.byKey(const Key('live-grant-floor-h9')), findsNothing);
      expect(find.byKey(const Key('live-decline-hand-h9')), findsNothing);

      await tester.ensureVisible(find.byKey(const Key('live-revoke-floor-h9')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-revoke-floor-h9')));
      await tester.pumpAndSettle();
      expect(repo.calls, ['revokeFloor:h9']);
      expect(find.text(LiveCopy.revokeFloorDone), findsOneWidget);
    });

    testWidgets('the host is never a target — their row carries no commands', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [_hand(id: 'h1', userId: 'u-host', displayName: 'المعلّم')],
          nextCursor: null,
        );
      await pump(tester, repo);
      await tester.pumpAndSettle();
      expect(find.text('المعلّم'), findsOneWidget);
      expect(find.byKey(const Key('live-remove-u-host')), findsNothing);
      expect(
        find.byKey(const Key('live-grant-presenter-u-host')),
        findsNothing,
      );
      // Nor a floor command — the host holds the floor by right.
      expect(find.byKey(const Key('live-grant-floor-h1')), findsNothing);
      expect(find.byKey(const Key('live-decline-hand-h1')), findsNothing);
    });

    testWidgets('after a command the roster is re-read, not fabricated', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [_hand(id: 'h1', userId: 'u-1')],
          nextCursor: null,
        );
      await pump(tester, repo);
      await tester.pumpAndSettle();
      final before = repo.handsCalls.length;

      await tester.ensureVisible(
        find.byKey(const Key('live-grant-presenter-u-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-grant-presenter-u-1')));
      await tester.pumpAndSettle();
      expect(repo.handsCalls.length, greaterThan(before));
    });

    testWidgets('a command refusal is said through the server’s code', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true))
        ..handsResult = LiveHandsPage(
          items: [_hand(id: 'h1', userId: 'u-1')],
          nextCursor: null,
        )
        ..commandError = const LiveException('live.presenter_slots_full', 'x');
      await pump(tester, repo);
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const Key('live-grant-presenter-u-1')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('live-grant-presenter-u-1')));
      await tester.pumpAndSettle();
      expect(
        find.text(LiveCopy.commandError('live.presenter_slots_full')),
        findsOneWidget,
      );
    });

    testWidgets('the filter forwards the chosen state to the server', (
      tester,
    ) async {
      final repo = fake(_session(canModerate: true));
      await pump(tester, repo);
      await tester.pumpAndSettle();
      expect(repo.handsCalls, ['hands:s-1:null:null']); // default: all

      await tester.tap(find.byTooltip(LiveCopy.rosterFilterTooltip));
      await tester.pumpAndSettle();
      await tester.tap(find.text(LiveCopy.rosterFilterGranted));
      await tester.pumpAndSettle();
      expect(repo.handsCalls.contains('hands:s-1:granted:null'), isTrue);
    });

    testWidgets('a failed roster read is said with a retry', (tester) async {
      final repo = fake(_session(canModerate: true))
        ..handsError = const LiveException('unavailable', 'x');
      await pump(tester, repo);
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.rosterError), findsOneWidget);
      expect(find.text(LiveCopy.retry), findsOneWidget);
    });
  });

  group('media panel wiring (Sprint 7)', () {
    testWidgets('a bound provider + canJoin shows the explicit join action', (
      tester,
    ) async {
      final client = FakeLiveMediaClient();
      addTearDown(client.dispose);
      await pump(tester, fake(_session(canJoin: true)), media: client);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-audio-join')), findsOneWidget);
      expect(find.text(LiveCopy.audioUnavailable), findsNothing);
    });

    testWidgets('no provider bound still says audio is unavailable in build', (
      tester,
    ) async {
      await pump(tester, fake(_session(canJoin: true)));
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.audioUnavailable), findsOneWidget);
      expect(find.byKey(const Key('live-audio-join')), findsNothing);
    });
  });

  group('live remote media chips (Sprint 11)', () {
    _FakeLive rosterRepo() =>
        fake(_session(canModerate: true))
          ..handsResult = LiveHandsPage(
            items: [
              _hand(id: 'h1', userId: 'u-1', state: SpeakerRequestState.granted),
            ],
            nextCursor: null,
          );

    testWidgets('a matched member shows live mic + screen-share indicators', (
      tester,
    ) async {
      final client = FakeLiveMediaClient();
      addTearDown(client.dispose);
      await pump(tester, rosterRepo(), media: client);
      await tester.pumpAndSettle();
      // Nothing live yet — the client sees no remote participants.
      expect(find.byKey(const Key('live-audio-on-u-1')), findsNothing);

      client.emitRemote(
        LiveRemoteParticipants(
          Map.unmodifiable({
            'u-1': const LiveRemoteParticipant(
              identity: 'u-1',
              audio: LiveRemoteAudio.live,
              screenSharing: true,
            ),
          }),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-audio-on-u-1')), findsOneWidget);
      expect(find.byKey(const Key('live-screen-sharing-u-1')), findsOneWidget);
      expect(find.text(LiveCopy.liveAudioOn), findsOneWidget);
    });

    testWidgets('a muted member shows the muted indicator, not mic-on', (
      tester,
    ) async {
      final client = FakeLiveMediaClient();
      addTearDown(client.dispose);
      await pump(tester, rosterRepo(), media: client);
      await tester.pumpAndSettle();
      client.emitRemote(
        LiveRemoteParticipants(
          Map.unmodifiable({
            'u-1': const LiveRemoteParticipant(
              identity: 'u-1',
              audio: LiveRemoteAudio.muted,
            ),
          }),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-audio-muted-u-1')), findsOneWidget);
      expect(find.byKey(const Key('live-audio-on-u-1')), findsNothing);
      expect(find.byKey(const Key('live-screen-sharing-u-1')), findsNothing);
    });

    testWidgets('an unmatched room member adds no indicators to this hand', (
      tester,
    ) async {
      final client = FakeLiveMediaClient();
      addTearDown(client.dispose);
      await pump(tester, rosterRepo(), media: client);
      await tester.pumpAndSettle();
      // A different identity is in the room — never this hand (u-1).
      client.emitRemote(
        LiveRemoteParticipants(
          Map.unmodifiable({
            'u-other': const LiveRemoteParticipant(
              identity: 'u-other',
              audio: LiveRemoteAudio.live,
            ),
          }),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('live-audio-on-u-1')), findsNothing);
    });
  });
}
