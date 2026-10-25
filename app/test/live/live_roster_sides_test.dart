import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_copy.dart';
import 'package:quran_institution_app/features/live/widgets/live_roster.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The moderator roster's «الكل» view shows BOTH sides the server keeps apart —
/// who holds the floor and the queue — so a speaker does not vanish the moment
/// the floor is granted (taking the revoke-floor and screen controls with
/// them). And someone presenting with no hand row (their floor revoked or
/// yielded while the screen grant stays open, ADR 0028 decision 5) still has a
/// revoke-screen control. The server answers one side per read (`pending` when
/// no state is given) — the fake mirrors that.
class _FakeLive implements LiveRepository {
  _FakeLive({required this.granted, required this.pending});

  final List<LiveHand> granted;
  final List<LiveHand> pending;
  final List<LiveHandsFilter?> reads = [];
  final List<String> revokedPresenters = [];

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async {
    reads.add(state);
    return LiveHandsPage(
      items: state == LiveHandsFilter.granted ? granted : pending,
      nextCursor: null,
      origin: DataOrigin.records,
    );
  }

  @override
  Future<LiveSession> revokePresenter(String sessionId, String userId) async {
    revokedPresenters.add(userId);
    return _session();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError(
    '${invocation.memberName} is not used by the roster',
  );
}

LiveHand _hand(
  String id,
  String user,
  String name,
  SpeakerRequestState state,
) => LiveHand(
  id: id,
  sessionId: 's-1',
  userId: user,
  state: state,
  requestedAt: DateTime.utc(2026),
  grantedAt: state == SpeakerRequestState.granted ? DateTime.utc(2026) : null,
  displayName: name,
);

LiveSession _session({List<String> presenters = const []}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: LiveSessionState.live,
  stateVersion: 1,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 2,
  presenterUserIds: presenters,
  me: const LiveMe(role: LiveParticipantRole.moderator, canModerate: true),
);

void main() {
  Future<_FakeLive> pump(
    WidgetTester tester, {
    List<String> presenters = const [],
  }) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repo = _FakeLive(
      granted: [_hand('h-1', 'u-a', 'سارة', SpeakerRequestState.granted)],
      pending: [_hand('h-2', 'u-b', 'أحمد', SpeakerRequestState.pending)],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(repo),
          liveMediaClientProvider.overrideWithValue(
            const UnavailableLiveMediaClient(),
          ),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Directionality(
              textDirection: TextDirection.rtl,
              child: SingleChildScrollView(
                child: LiveRoster(session: _session(presenters: presenters)),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return repo;
  }

  Future<void> choose(WidgetTester tester, String filter) async {
    await tester.tap(find.byIcon(Icons.filter_list_rounded));
    await tester.pumpAndSettle();
    await tester.tap(find.text(filter).last);
    await tester.pumpAndSettle();
  }

  testWidgets('«الكل» shows the granted speaker AND the queue, each with its '
      'controls', (tester) async {
    final repo = await pump(tester);
    expect(repo.reads, unorderedEquals([LiveHandsFilter.granted, null]));
    // The granted speaker is listed, with revoke-floor and screen controls.
    expect(find.text('سارة'), findsOneWidget);
    expect(find.byKey(const Key('live-revoke-floor-h-1')), findsOneWidget);
    expect(find.byKey(const Key('live-grant-presenter-u-a')), findsOneWidget);
    // The queue is listed, with grant/decline.
    expect(find.text('أحمد'), findsOneWidget);
    expect(find.byKey(const Key('live-grant-floor-h-2')), findsOneWidget);
  });

  testWidgets('the narrower filters still show one side each', (tester) async {
    final repo = await pump(tester);
    await choose(tester, LiveCopy.rosterFilterPending);
    expect(repo.reads.last, LiveHandsFilter.pending);
    expect(find.text('أحمد'), findsOneWidget);
    expect(find.text('سارة'), findsNothing);

    await choose(tester, LiveCopy.rosterFilterGranted);
    expect(repo.reads.last, LiveHandsFilter.granted);
    expect(find.text('سارة'), findsOneWidget);
    expect(find.text('أحمد'), findsNothing);
  });

  testWidgets(
    'a presenter with no hand row can still have the screen revoked',
    (tester) async {
      final repo = await pump(tester, presenters: ['u-c']);
      final revoke = find.byKey(const Key('live-revoke-presenter-u-c'));
      expect(revoke, findsOneWidget);
      await tester.tap(revoke);
      await tester.pumpAndSettle();
      expect(repo.revokedPresenters, ['u-c']);
    },
  );

  testWidgets('a presenter who has a hand row is not listed twice', (
    tester,
  ) async {
    await pump(tester, presenters: ['u-a']);
    expect(find.byKey(const Key('live-revoke-presenter-u-a')), findsOneWidget);
    expect(find.text('سارة'), findsOneWidget);
  });

  testWidgets('the host is never a presenter-only command target', (
    tester,
  ) async {
    await pump(tester, presenters: ['u-host']);
    expect(find.byKey(const Key('live-revoke-presenter-u-host')), findsNothing);
  });
}
