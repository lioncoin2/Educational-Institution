@Tags(['golden'])
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/live_session_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'fake_live_media_client.dart';

/// Renders the REAL redesigned live screen to PNGs (golden-tagged, excluded from
/// the normal suite) with the app's Arabic fonts loaded — visual evidence of the
/// immersive broadcast surface, not a mock. Generate with:
///   LIVE_SHOTS_DIR=/some/dir flutter test --tags golden test/live/live_screenshots_test.dart
///
/// The PNGs go to `LIVE_SHOTS_DIR` when it is set (to keep them for review), or
/// else to a fresh system temp directory, so the test runs on any machine.
final Directory _outDir = () {
  final requested = Platform.environment['LIVE_SHOTS_DIR'];
  final dir = requested != null && requested.isNotEmpty
      ? Directory(requested)
      : Directory.systemTemp.createTempSync('live-shots-');
  return dir..createSync(recursive: true);
}();

Future<void> _loadFonts() async {
  const families = {
    'Almarai': [
      'assets/fonts/Almarai-Regular.ttf',
      'assets/fonts/Almarai-Bold.ttf',
      'assets/fonts/Almarai-ExtraBold.ttf',
    ],
    'PlexArabic': [
      'assets/fonts/IBMPlexSansArabic-Regular.ttf',
      'assets/fonts/IBMPlexSansArabic-Medium.ttf',
      'assets/fonts/IBMPlexSansArabic-SemiBold.ttf',
    ],
  };
  for (final entry in families.entries) {
    final loader = FontLoader(entry.key);
    for (final path in entry.value) {
      loader.addFont(rootBundle.load(path));
    }
    await loader.load();
  }
  final flutterRoot = Platform.environment['FLUTTER_ROOT'] ?? '/opt/flutter';
  final iconFile = File(
    '$flutterRoot/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
  );
  if (iconFile.existsSync()) {
    final loader = FontLoader('MaterialIcons')
      ..addFont(iconFile.readAsBytes().then((b) => ByteData.sublistView(b)));
    await loader.load();
  }
}

class _Repo implements LiveRepository {
  _Repo(this.session, this.handsPage);

  final LiveSession session;
  final LiveHandsPage handsPage;

  @override
  Future<LiveSession?> currentSession(String communityId) async => session;

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async => handsPage;

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

LiveHand _hand(
  String id,
  String user,
  String name, {
  SpeakerRequestState state = SpeakerRequestState.pending,
}) => LiveHand(
  id: id,
  sessionId: 's-1',
  userId: user,
  state: state,
  requestedAt: DateTime.utc(2026),
  grantedAt: state == SpeakerRequestState.granted ? DateTime.utc(2026) : null,
  displayName: name,
);

LiveSession _session({
  bool moderator = false,
  bool ended = false,
  bool canRaiseHand = false,
}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: ended ? LiveSessionState.ended : LiveSessionState.live,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026, 1, 1, 10),
  endedAt: ended ? DateTime.utc(2026, 1, 1, 11, 12) : null,
  endReason: ended ? LiveSessionEndReason.moderator : null,
  speakerCount: 3,
  moderation: moderator
      ? const LiveModeration(pendingHands: 3, violations: 0)
      : null,
  me: LiveMe(
    role: moderator
        ? LiveParticipantRole.moderator
        : LiveParticipantRole.listener,
    canJoin: true,
    canModerate: moderator,
    canEnd: moderator,
    canPresent: moderator,
    canRaiseHand: canRaiseHand,
  ),
  origin: DataOrigin.records,
);

Future<void> _shot(
  WidgetTester tester,
  String name,
  Size size,
  LiveSession session, {
  bool openParticipants = false,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final handsPage = LiveHandsPage(
    items: [
      _hand('h1', 'u-1', 'سارة أحمد', state: SpeakerRequestState.granted),
      _hand('h2', 'u-2', 'أحمد خالد'),
      _hand('h3', 'u-3', 'لينا علي'),
    ],
    nextCursor: null,
  );
  final client = FakeLiveMediaClient();
  addTearDown(client.dispose);

  final key = GlobalKey();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        liveRepositoryProvider.overrideWithValue(_Repo(session, handsPage)),
        liveMediaClientProvider.overrideWithValue(client),
        sessionUserProvider.overrideWith((ref) async => null),
      ],
      child: RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          home: const LiveSessionScreen(communityId: 'c-1'),
          builder: (context, child) =>
              Directionality(textDirection: TextDirection.rtl, child: child!),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();

  if (openParticipants) {
    await tester.tap(find.byKey(const Key('live-stage-participants')));
    await tester.pumpAndSettle();
  }

  final boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  // toImage schedules real engine async; draining it under runAsync lets the
  // test tear down cleanly instead of hanging.
  final bytes = await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    return data!.buffer.asUint8List();
  });
  final file = File('${_outDir.path}/live-shot-$name.png')
    ..writeAsBytesSync(bytes!);
  expect(file.lengthSync(), greaterThan(0));
}

void main() {
  setUpAll(_loadFonts);

  // One shot per test: each gets a clean teardown (repeated pumpWidget +
  // toImage in a single test can accumulate and hang pumpAndSettle).
  const fast = Timeout(Duration(seconds: 90));

  testWidgets('phone moderator', (tester) async {
    await _shot(tester, 'phone-moderator', const Size(390, 844),
        _session(moderator: true));
  }, timeout: fast);

  testWidgets('phone listener', (tester) async {
    await _shot(tester, 'phone-listener', const Size(390, 844),
        _session(canRaiseHand: true));
  }, timeout: fast);

  testWidgets('desktop moderator', (tester) async {
    await _shot(tester, 'desktop-moderator', const Size(1280, 860),
        _session(moderator: true));
  }, timeout: fast);

  testWidgets('phone ended', (tester) async {
    await _shot(tester, 'phone-ended', const Size(390, 844),
        _session(ended: true));
  }, timeout: fast);

  testWidgets('phone participants', (tester) async {
    await _shot(tester, 'phone-participants', const Size(390, 844),
        _session(moderator: true), openParticipants: true);
  }, timeout: fast);
}
