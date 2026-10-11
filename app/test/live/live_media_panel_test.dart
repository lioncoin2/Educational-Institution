import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/widgets/live_media_panel.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'fake_live_media_client.dart';

LiveMediaGrant _grant(String sessionId) => LiveMediaGrant(
  sessionId: sessionId,
  token: 'token-for-$sessionId',
  url: 'wss://live.test',
  expiresInSeconds: 120,
  expiresAt: DateTime.utc(2026),
  role: LiveParticipantRole.listener,
  microphone: true,
  screen: true,
  screenAudio: false,
);

LiveSession _session({
  String id = 's-1',
  bool canJoin = true,
  bool presenting = false,
}) => LiveSession(
  id: id,
  communityId: 'c-1',
  state: LiveSessionState.live,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 0,
  me: LiveMe(canJoin: canJoin, presenting: presenting),
  origin: DataOrigin.records,
);

/// A repository the panel drives: it records how often (and for which session)
/// `/join` was asked, can hold a join in flight (for the duplicate/pending
/// race) and can refuse it. The panel must touch nothing else.
class _FakeLive implements LiveRepository {
  final List<String> joinedIds = [];
  Completer<void>? holdJoin;
  Object? joinError;

  @override
  Future<LiveMediaGrant> join(String sessionId) async {
    joinedIds.add(sessionId);
    if (holdJoin != null) await holdJoin!.future;
    if (joinError != null) throw joinError!;
    return _grant(sessionId);
  }

  @override
  Future<LiveSession> getSession(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession?> currentSession(String communityId) =>
      throw UnimplementedError();
  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) => throw UnimplementedError();
  @override
  Future<LiveSession> endSession(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  }) => throw UnimplementedError();
  @override
  Future<bool> resetRoom(String sessionId) => throw UnimplementedError();
  @override
  Future<LiveSession> claimPresenter(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> stopPresenter(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> grantPresenter(String sessionId, String userId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> revokePresenter(String sessionId, String userId) =>
      throw UnimplementedError();
}

class _Harness {
  _Harness({required this.session, required this.repo, required this.client});

  final ValueNotifier<LiveSession> session;
  final _FakeLive repo;
  final FakeLiveMediaClient client;
}

void main() {
  Future<_Harness> pump(
    WidgetTester tester,
    LiveSession initial, {
    LiveMediaClient? media,
  }) async {
    final repo = _FakeLive();
    final client = FakeLiveMediaClient();
    addTearDown(client.dispose);
    final session = ValueNotifier<LiveSession>(initial);
    addTearDown(session.dispose);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveMediaClientProvider.overrideWithValue(media ?? client),
          liveRepositoryProvider.overrideWithValue(repo),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: ValueListenableBuilder<LiveSession>(
                valueListenable: session,
                builder: (_, s, _) => LiveMediaPanel(session: s),
              ),
            ),
          ),
          builder: (context, child) =>
              Directionality(textDirection: TextDirection.rtl, child: child!),
        ),
      ),
    );
    return _Harness(session: session, repo: repo, client: client);
  }

  /// Join → connected, the way the UI does it (no spinner-settling: the
  /// connecting state shows an endless progress indicator). Seeds the reconciled
  /// publication the adapter would emit on connect (authorization + tracks).
  Future<void> connect(
    WidgetTester tester,
    _Harness h, {
    bool screenAuthorized = false,
    bool microphoneOn = false,
    bool screenShareOn = false,
  }) async {
    await tester.tap(find.byKey(const Key('live-audio-join')));
    await tester.pump(); // connecting shown; the held-free join resolves
    await tester.pump(); // client.connect lands
    h.client.emit(const LiveMediaConnected());
    h.client.emitPublication(
      LiveMediaPublication(
        screenAuthorized: screenAuthorized,
        microphoneOn: microphoneOn,
        screenShareOn: screenShareOn,
      ),
    );
    // Connected has no persistent spinner: settle so the ConnectedCard mounts
    // and the publication provider seeds its value into the widget.
    await tester.pumpAndSettle();
  }

  group('availability and idle', () {
    testWidgets('no provider bound → the audio-unavailable card, no join', (
      tester,
    ) async {
      await pump(tester, _session(), media: const UnavailableLiveMediaClient());
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.audioUnavailable), findsOneWidget);
      expect(find.text(LiveCopy.audioUnavailableMessage), findsOneWidget);
      expect(find.byKey(const Key('live-audio-join')), findsNothing);
    });

    testWidgets('idle + canJoin → the prompt and an explicit join action', (
      tester,
    ) async {
      await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.audioIdlePrompt), findsOneWidget);
      expect(find.byKey(const Key('live-audio-join')), findsOneWidget);
    });

    testWidgets('idle without canJoin → not-available, no join action', (
      tester,
    ) async {
      await pump(tester, _session(canJoin: false));
      await tester.pumpAndSettle();
      expect(find.text(LiveCopy.audioJoinUnavailable), findsOneWidget);
      expect(find.byKey(const Key('live-audio-join')), findsNothing);
    });

    testWidgets('joining never happens on build — only on the tap', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      expect(h.repo.joinedIds, isEmpty);
      expect(h.client.connects, isEmpty);
    });
  });

  group('join', () {
    testWidgets('tapping join calls /join for the SESSION id, shows joining', (
      tester,
    ) async {
      final h = await pump(tester, _session(id: 's-9', canJoin: true));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('live-audio-join')));
      await tester.pump();
      await tester.pump();

      // The session id, never the community id — one session cannot drive
      // another's media.
      expect(h.repo.joinedIds, ['s-9']);
      expect(h.client.connects.single.sessionId, 's-9');
      expect(find.text(LiveCopy.audioJoining), findsOneWidget);
    });

    testWidgets('once joining, the join action is gone — no duplicate /join', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      h.repo.holdJoin = Completer<void>(); // keep the join in flight

      await tester.tap(find.byKey(const Key('live-audio-join')));
      await tester.pump();

      expect(find.text(LiveCopy.audioJoining), findsOneWidget);
      expect(find.byKey(const Key('live-audio-join')), findsNothing);
      expect(h.repo.joinedIds, hasLength(1));

      h.repo.holdJoin!.complete();
      await tester.pump();
    });

    testWidgets('a join refusal is said through the server code, stays idle', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      h.repo.joinError = const LiveException('live.session_not_live', 'no');

      await tester.tap(find.byKey(const Key('live-audio-join')));
      await tester.pump(); // connecting
      await tester.pump(); // the refusal returns us to idle
      await tester.pump(); // the toast shows

      expect(
        find.text(LiveCopy.commandError('live.session_not_live')),
        findsOneWidget,
      );
      // Back to idle — the join action is offered again (never a fake connect).
      expect(find.byKey(const Key('live-audio-join')), findsOneWidget);
    });

    testWidgets('a media-connect failure shows the failed state and a retry', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      h.client.failNext = const LiveMediaException('connect_failed', 'x');

      await tester.tap(find.byKey(const Key('live-audio-join')));
      await tester.pump();
      await tester.pump();

      expect(find.text(LiveCopy.audioFailed), findsOneWidget);
      expect(find.byKey(const Key('live-audio-retry')), findsOneWidget);

      // Retrying connects again.
      h.client.failNext = null;
      await tester.tap(find.byKey(const Key('live-audio-retry')));
      await tester.pump();
      await tester.pump();
      expect(h.repo.joinedIds, hasLength(2));
    });
  });

  group('connected and microphone', () {
    testWidgets('connected shows the title, a muted mic and a leave action', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);

      expect(find.text(LiveCopy.audioConnectedTitle), findsOneWidget);
      expect(find.text(LiveCopy.micOffStatus), findsOneWidget);
      expect(find.byKey(const Key('live-mic-toggle')), findsOneWidget);
      expect(find.byKey(const Key('live-audio-leave')), findsOneWidget);
      // No screen share unless this viewer presents.
      expect(find.byKey(const Key('live-screen-toggle')), findsNothing);
    });

    testWidgets('mic does not open on join — explicit intent only', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);
      // Connected, but the microphone was never commanded.
      expect(h.client.microphoneCommands, isEmpty);
      expect(find.text(LiveCopy.micOffStatus), findsOneWidget);
    });

    testWidgets('enabling the mic commands the client; the SDK state reflects on, then off', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);

      // The tap commands the client — but the UI does NOT flip until the SDK's
      // reconciled publication confirms the track is published.
      await tester.tap(find.text(LiveCopy.micEnable));
      await tester.pump();
      expect(h.client.microphoneCommands, [true]);
      expect(find.text(LiveCopy.micOffStatus), findsOneWidget); // not yet
      h.client.emitPublication(const LiveMediaPublication(microphoneOn: true));
      await tester.pump();
      expect(find.text(LiveCopy.micOnStatus), findsOneWidget); // SDK-confirmed

      await tester.tap(find.text(LiveCopy.micDisable));
      await tester.pump();
      expect(h.client.microphoneCommands, [true, false]);
      h.client.emitPublication(const LiveMediaPublication(microphoneOn: false));
      await tester.pump();
      expect(find.text(LiveCopy.micOffStatus), findsOneWidget);
    });

    testWidgets('an external mute (no command) is reconciled into the UI', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h, microphoneOn: true);
      expect(find.text(LiveCopy.micOnStatus), findsOneWidget);

      // The SDK reports the track muted (a server mute, a device loss) with no
      // command from us — the UI must reflect the real state.
      h.client.emitPublication(const LiveMediaPublication(microphoneOn: false));
      await tester.pump();
      expect(find.text(LiveCopy.micOffStatus), findsOneWidget);
      expect(h.client.microphoneCommands, isEmpty); // reconciled, not commanded
    });

    testWidgets('a denied mic is said recoverably and stays off', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);
      h.client.failNext = const LiveMediaException('media_error', 'denied');

      await tester.tap(find.text(LiveCopy.micEnable));
      await tester.pump();
      await tester.pump();

      expect(h.client.microphoneCommands, [true]); // attempted
      expect(find.text(LiveCopy.micError), findsOneWidget); // recoverable
      expect(find.text(LiveCopy.micOffStatus), findsOneWidget); // not faked on
    });

    testWidgets('a pending mic command blocks a second — no duplicate publish', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);
      h.client.hold = Completer<void>();

      await tester.tap(find.text(LiveCopy.micEnable));
      await tester.pump(); // in flight: spinner, disabled
      await tester.tap(find.text(LiveCopy.micEnable)); // ignored while busy
      await tester.pump();
      expect(h.client.microphoneCommands, [true]);

      h.client.hold!.complete();
      await tester.pump();
      // The command resolved; the SDK's reconciled publication confirms on.
      h.client.emitPublication(const LiveMediaPublication(microphoneOn: true));
      await tester.pump();
      expect(find.text(LiveCopy.micOnStatus), findsOneWidget);
    });
  });

  group('screen share (presenter, authorization-gated)', () {
    testWidgets('shown to a presenter, hidden to a non-presenter', (tester) async {
      final h = await pump(tester, _session(canJoin: true, presenting: true));
      await tester.pumpAndSettle();
      await connect(tester, h, screenAuthorized: true);
      expect(find.byKey(const Key('live-screen-toggle')), findsOneWidget);
    });

    testWidgets('start stays disabled until authorization is confirmed (the race)', (
      tester,
    ) async {
      // Presenter by session authority, but the live screen authorization has
      // not reached this device yet: the control shows, start is disabled with
      // a confirming hint, and a tap sends nothing — no refusal in the race.
      final h = await pump(tester, _session(canJoin: true, presenting: true));
      await tester.pumpAndSettle();
      await connect(tester, h); // screenAuthorized: false

      expect(find.byKey(const Key('live-screen-toggle')), findsOneWidget);
      expect(find.text(LiveCopy.screenShareConfirming), findsOneWidget);
      await tester.ensureVisible(find.text(LiveCopy.screenShareStart));
      await tester.tap(find.text(LiveCopy.screenShareStart));
      await tester.pump();
      expect(h.client.screenShareCommands, isEmpty); // disabled → nothing sent

      // Authorization confirmed live → start enables, the hint clears.
      h.client.emitPublication(
        const LiveMediaPublication(screenAuthorized: true),
      );
      await tester.pump();
      expect(find.text(LiveCopy.screenShareConfirming), findsNothing);
      await tester.ensureVisible(find.text(LiveCopy.screenShareStart));
      await tester.tap(find.text(LiveCopy.screenShareStart));
      await tester.pump();
      expect(h.client.screenShareCommands, [true]);
    });

    testWidgets('starting commands the client; the SDK state reflects published', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true, presenting: true));
      await tester.pumpAndSettle();
      await connect(tester, h, screenAuthorized: true);

      await tester.ensureVisible(find.text(LiveCopy.screenShareStart));
      await tester.tap(find.text(LiveCopy.screenShareStart));
      await tester.pump();
      expect(h.client.screenShareCommands, [true]);
      expect(find.text(LiveCopy.screenShareOnStatus), findsNothing); // not yet

      h.client.emitPublication(
        const LiveMediaPublication(screenAuthorized: true, screenShareOn: true),
      );
      await tester.pump();
      expect(find.text(LiveCopy.screenShareOnStatus), findsOneWidget);
    });

    testWidgets('a cancelled/failed share is said recoverably, stays off', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true, presenting: true));
      await tester.pumpAndSettle();
      await connect(tester, h, screenAuthorized: true);
      h.client.failNext = const LiveMediaException('media_error', 'x');

      await tester.ensureVisible(find.text(LiveCopy.screenShareStart));
      await tester.tap(find.text(LiveCopy.screenShareStart));
      await tester.pump();
      await tester.pump();

      expect(h.client.screenShareCommands, [true]); // attempted
      expect(find.text(LiveCopy.screenShareError), findsOneWidget);
      // No publication confirmed it on → the control stays at "start".
      expect(find.text(LiveCopy.screenShareStart), findsOneWidget);
    });

    testWidgets('losing the presenter slot stops the capture and hides the control', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true, presenting: true));
      await tester.pumpAndSettle();
      await connect(tester, h, screenAuthorized: true);

      await tester.ensureVisible(find.text(LiveCopy.screenShareStart));
      await tester.tap(find.text(LiveCopy.screenShareStart));
      await tester.pump();
      h.client.emitPublication(
        const LiveMediaPublication(screenAuthorized: true, screenShareOn: true),
      );
      await tester.pump();
      expect(find.text(LiveCopy.screenShareOnStatus), findsOneWidget);

      // The moderator revokes: the session reconciles presenting→false (the
      // panel tells the client to stop) and the SDK unpublishes the track.
      h.session.value = _session(canJoin: true, presenting: false);
      await tester.pump();
      expect(h.client.screenShareCommands, [true, false]);
      h.client.emitPublication(const LiveMediaPublication());
      await tester.pump();
      expect(find.byKey(const Key('live-screen-toggle')), findsNothing);
    });

    testWidgets('re-granting after a revoke shows capture as off, not stale-on', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true, presenting: true));
      await tester.pumpAndSettle();
      await connect(tester, h, screenAuthorized: true);

      await tester.ensureVisible(find.text(LiveCopy.screenShareStart));
      await tester.tap(find.text(LiveCopy.screenShareStart));
      await tester.pump();
      h.client.emitPublication(
        const LiveMediaPublication(screenAuthorized: true, screenShareOn: true),
      );
      await tester.pump();
      expect(find.text(LiveCopy.screenShareOnStatus), findsOneWidget);

      // Revoke (track stops, authorization lost), then re-grant.
      h.session.value = _session(canJoin: true, presenting: false);
      await tester.pump();
      h.client.emitPublication(const LiveMediaPublication());
      await tester.pump();
      h.session.value = _session(canJoin: true, presenting: true);
      h.client.emitPublication(
        const LiveMediaPublication(screenAuthorized: true),
      );
      await tester.pump();

      // Back, reading OFF — the reconciled state, never a stale "sharing".
      expect(find.byKey(const Key('live-screen-toggle')), findsOneWidget);
      expect(find.text(LiveCopy.screenShareStart), findsOneWidget);
      expect(find.text(LiveCopy.screenShareOnStatus), findsNothing);
    });
  });

  group('lifecycle', () {
    testWidgets('reconnecting shows the line and disables the mic command', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);

      h.client.emit(const LiveMediaReconnecting());
      await tester.pump();
      expect(find.text(LiveCopy.audioReconnecting), findsOneWidget);

      // The mic control is shown but disabled — a tap sends nothing.
      await tester.tap(find.text(LiveCopy.micEnable));
      await tester.pump();
      expect(h.client.microphoneCommands, isEmpty);
    });

    testWidgets('leaving disconnects the client and returns to idle', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);

      await tester.ensureVisible(find.byKey(const Key('live-audio-leave')));
      await tester.tap(find.byKey(const Key('live-audio-leave')));
      await tester.pump();

      expect(h.client.disconnects, 1);
      // Idle again: the explicit join action is offered (never auto-rejoin).
      expect(find.byKey(const Key('live-audio-join')), findsOneWidget);
    });

    testWidgets('participantRemoved shows the removed message and a rejoin', (
      tester,
    ) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);

      h.client.emit(
        const LiveMediaDisconnected(
          LiveMediaDisconnectReason.participantRemoved,
        ),
      );
      await tester.pump();
      expect(find.text(LiveCopy.audioRemoved), findsOneWidget);
      expect(find.byKey(const Key('live-audio-rejoin')), findsOneWidget);

      // Re-entry is the person's explicit choice.
      await tester.tap(find.byKey(const Key('live-audio-rejoin')));
      await tester.pump();
      await tester.pump();
      expect(h.repo.joinedIds, hasLength(2));
    });

    testWidgets('duplicateIdentity shows the evicted message', (tester) async {
      final h = await pump(tester, _session(canJoin: true));
      await tester.pumpAndSettle();
      await connect(tester, h);

      h.client.emit(
        const LiveMediaDisconnected(
          LiveMediaDisconnectReason.duplicateIdentity,
        ),
      );
      await tester.pump();
      expect(find.text(LiveCopy.audioEvicted), findsOneWidget);
    });
  });
}
