// Real TWO-CLIENT LiveKit SCREEN-SHARE end-to-end (Sprint 13).
//
// This is the test Sprints 7-12 could not be: a GENUINE browser display
// capture, published as a real screen-share track through the production SDK
// path, received by a second independent client — all against the real pinned
// LiveKit 1.13.7. It closes the one gap the whole media programme kept open and
// documented: "real screen CAPTURE is NOT verified — headless Chrome has no
// getDisplayMedia source" (docs/p8-live-media-verification.md, path 3).
//
// It REQUIRES A REAL DISPLAY. `getDisplayMedia()` has no source in headless
// Chrome, so this test is run only by the dedicated workflow step that launches
// headed Chrome on an Xvfb virtual display with
// `--auto-select-desktop-capture-source` (see .github/workflows/live-e2e.yml).
// The capture is a real screen-capture track off Chrome's own capture pipeline —
// NOT `--use-fake-device-for-media-stream` (that fakes a camera, never the
// display). With no display / no source, `setScreenShareEnabled(true)` throws,
// and the test fails loudly rather than passing on a fake.
//
// Topology (two INDEPENDENT production clients, one real room, distinct
// backend-authorized identities):
//
//   Client A = the owner/host (LIVEKIT_E2E_ACCESS_TOKEN). It CLAIMS the
//              presenter slot through the real backend
//              (POST /live/sessions/:id/screen-share) — the same authorization
//              path the single-client E2E proves — so the LiveKit server pushes
//              it `canPublishSources: [screen]`. No permission is invented.
//   Client B = the second STUDENT (LIVEKIT_E2E_ACCESS_TOKEN_B), provisioned by
//              the Sprint 12 fixture. It only OBSERVES; it never shares.
//
// The six states the sprint keeps distinct are asserted separately and never
// collapsed into one another:
//   1. presenter authority         → clientA.screenAuthorized
//   2. server screen capability     → (the same; the live SDK permission)
//   3. a real capture source obtained + 4. a track actually published
//                                   → clientA.publication.screenShareOn (local)
//   5. the remote receives the track → clientB.remoteParticipants[A].screenSharing
//   6. the remote app state reflects start AND stop (the same, reconciled).
// Authority is explicitly asserted NOT to imply an active share (3/4/5).
//
// Assertions are at the APPLICATION boundary (each client's publication /
// remoteParticipants), not SDK internals. Waits are bounded and event-driven.
//
// RUN (web only; needs headed Chrome on a real/virtual display and a backend in
// real LiveKit mode):
//
//   xvfb-run -a flutter test test/e2e/livekit_two_client_screenshare_e2e_test.dart \
//     --platform chrome \
//     --dart-define=LIVEKIT_E2E_BASE_URL=http://127.0.0.1:3000 \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN=<owner token> \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN_B=<participant token> \
//     --dart-define=LIVEKIT_E2E_SESSION_ID=<active live session id> \
//     --dart-define=LIVEKIT_E2E_USER_B=<participant user id>
//
// With any required define unset the test SKIPS. No token is ever logged.
@TestOn('browser')
library;

import 'dart:async';

// The WebRTC media API — the SAME package (and the SAME
// `navigator.mediaDevices.getDisplayMedia`) the LiveKit SDK calls internally, so
// the diagnostic probe below replicates the production capture call exactly and
// surfaces the RAW DOM error (before the SDK wraps it as TrackCreateException).
// ignore: depend_on_referenced_packages
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;
// Flutter's platform signal. flutter_test reports defaultTargetPlatform as
// `android` by default; this test overrides it to a DESKTOP platform (below) so
// the SDK's web-mobile guard does not refuse screen share — see the note in main.
import 'package:flutter/foundation.dart' show debugDefaultTargetPlatformOverride, TargetPlatform;

// connectivity_plus's official web implementation entry point — see the note in
// livekit_web_e2e_test.dart: `flutter test --platform chrome` does not run the
// generated web plugin registrant, so the SDK's connectivity check would hang.
// ignore: implementation_imports, depend_on_referenced_packages
import 'package:connectivity_plus/src/connectivity_plus_web.dart';
import 'package:flutter_test/flutter_test.dart';
// ignore: depend_on_referenced_packages
import 'package:flutter_web_plugins/flutter_web_plugins.dart';
import 'package:http/http.dart' as http;
// ignore: depend_on_referenced_packages
import 'package:logging/logging.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_live_media_client.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/http/http_live_repository.dart';

const _baseUrl = String.fromEnvironment('LIVEKIT_E2E_BASE_URL');
const _tokenA = String.fromEnvironment('LIVEKIT_E2E_ACCESS_TOKEN');
const _tokenB = String.fromEnvironment('LIVEKIT_E2E_ACCESS_TOKEN_B');
const _sessionId = String.fromEnvironment('LIVEKIT_E2E_SESSION_ID');
const _userB = String.fromEnvironment('LIVEKIT_E2E_USER_B');

/// Redacts any JWT or token/secret value before a diagnostic line is printed.
String _redact(String input) => input
    .replaceAll(
      RegExp(r'[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}'),
      '<jwt-redacted>',
    )
    .replaceAllMapped(
      RegExp(r'(access_token|token|secret|authorization)=[^&\s"]+', caseSensitive: false),
      (m) => '${m[1]}=<redacted>',
    );

/// Polls [condition] until true or the bounded [timeout] — for a genuinely
/// asynchronous server → SDK → adapter update. Never an unbounded sleep.
Future<void> _until(
  bool Function() condition, {
  required String reason,
  Duration timeout = const Duration(seconds: 30),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) fail(reason);
    await Future<void>.delayed(const Duration(milliseconds: 200));
  }
}

HttpLiveRepository _repoFor(String token, http.Client httpClient) {
  final store = InMemoryTokenStore();
  // ignore: discarded_futures
  store.write(Tokens(accessToken: token, refreshToken: token));
  return HttpLiveRepository(
    ApiClient(
      baseUri: Uri.parse(_baseUrl.endsWith('/') ? _baseUrl : '$_baseUrl/'),
      httpClient: httpClient,
      tokenStore: store,
    ),
  );
}

Future<void> _awaitConnected(LiveKitLiveMediaClient client, LiveMediaGrant grant) async {
  final settled = Completer<LiveMediaState>();
  final sub = client.states.listen((state) {
    if (!settled.isCompleted &&
        (state is LiveMediaConnected ||
            state is LiveMediaFailed ||
            state is LiveMediaDisconnected)) {
      settled.complete(state);
    }
  });
  try {
    await client.connect(grant);
    final result = await settled.future.timeout(const Duration(seconds: 25));
    expect(result, isA<LiveMediaConnected>(), reason: 'the client did not reach connected');
  } finally {
    await sub.cancel();
  }
}

/// DIAGNOSTIC + state-3 probe: calls the browser's getDisplayMedia DIRECTLY so
/// the exact capture outcome (a real video track, or a precise DOM error such as
/// NotFoundError / NotReadableError / NotAllowedError) is visible in the log, and
/// so "a real display-capture source exists" is checked on its own — separate
/// from an actually-published track (the production path below does the real
/// publish). Returns the video-track count; prints and rethrows the exact error
/// on failure so a capture problem is self-diagnosing in CI. Stops the probe's
/// own tracks immediately (it is not the track the SDK publishes).
Future<int> _probeDisplayMediaTrackCount() async {
  try {
    final stream = await rtc.navigator.mediaDevices.getDisplayMedia(
      <String, dynamic>{'video': true},
    );
    final tracks = stream.getVideoTracks();
    for (final track in tracks) {
      await track.stop();
    }
    await stream.dispose();
    return tracks.length;
  } catch (error) {
    // ignore: avoid_print
    print('LKDIAG screen-probe: getDisplayMedia threw ${error.runtimeType}: $error');
    rethrow;
  }
}

void main() {
  // The browser E2E needs a live Flutter binding before livekit_client touches
  // Flutter state during Room.connect (as in livekit_web_e2e_test.dart).
  TestWidgetsFlutterBinding.ensureInitialized();
  ConnectivityPlusWebPlugin.registerWith(webPluginRegistrar);

  // flutter_test reports defaultTargetPlatform as `android` by default. The
  // LiveKit SDK's screen-share guard refuses capture on web-MOBILE
  // (`createScreenShareTrack` throws "Screen sharing is not supported on mobile
  // devices" when defaultTargetPlatform is android/iOS). A REAL desktop web
  // browser — the only platform ADR 0030 ships — reports a desktop platform and
  // is allowed. Override to a desktop platform so this test faithfully exercises
  // the DESKTOP-web screen-share path it is meant to verify. This is a test-only
  // correction of a flutter_test environment default; it changes no production
  // behaviour, authorization, or browser security, and the capture itself is
  // still a real getDisplayMedia track (proven by the probe below).
  debugDefaultTargetPlatformOverride = TargetPlatform.linux;
  tearDownAll(() => debugDefaultTargetPlatformOverride = null);

  test('real browser screen capture publishes to a second client and reconciles on stop', () async {
    if (_baseUrl.isEmpty ||
        _tokenA.isEmpty ||
        _tokenB.isEmpty ||
        _sessionId.isEmpty ||
        _userB.isEmpty) {
      markTestSkipped(
        'two-client screen-share E2E not configured — set LIVEKIT_E2E_BASE_URL, '
        'LIVEKIT_E2E_ACCESS_TOKEN, LIVEKIT_E2E_ACCESS_TOKEN_B, '
        'LIVEKIT_E2E_SESSION_ID and LIVEKIT_E2E_USER_B (--dart-define).',
      );
      return;
    }

    // Redacted SDK diagnostics, re-emitted on teardown so even a hang surfaces.
    Logger.root.level = Level.ALL;
    final diag = <String>[];
    final sub = Logger.root.onRecord.listen((r) {
      final line = 'LKDIAG ${r.level.name} ${r.loggerName}: ${_redact(r.message)}';
      diag.add(line);
      // ignore: avoid_print
      print(line);
    });
    addTearDown(sub.cancel);
    addTearDown(() {
      // ignore: avoid_print
      print('LKDIAG flush (${diag.length} records)');
    });

    final httpA = http.Client();
    final httpB = http.Client();
    final clientA = LiveKitLiveMediaClient();
    final clientB = LiveKitLiveMediaClient();
    // Deterministic cleanup on EVERY path: stop presenter (best-effort, so a
    // revoked slot never lingers for the next test on this shared session),
    // then disconnect + dispose both clients, then close both HTTP clients.
    final repoA = _repoFor(_tokenA, httpA);
    final repoB = _repoFor(_tokenB, httpB);
    addTearDown(() async {
      try {
        await repoA.stopPresenter(_sessionId);
      } on Object {
        // The slot may already be released; cleanup must not fail the test.
      }
      await clientA.disconnect();
      await clientB.disconnect();
      await clientA.dispose();
      await clientB.dispose();
      httpA.close();
      httpB.close();
    });

    // 1. Separate, backend-authorized grants for the SAME session/room, then
    //    connect both independent clients.
    final grantA = await repoA.join(_sessionId);
    final grantB = await repoB.join(_sessionId);
    await _awaitConnected(clientA, grantA);
    await _awaitConnected(clientB, grantB);

    // 2. Each observes the other. B's single remote is A — capture A's identity
    //    (= A's backend user id) from B's own view, so no extra define is needed.
    await _until(
      () => clientB.remoteParticipants.length == 1,
      reason: 'client B never observed client A as a remote participant',
    );
    final aIdentity = clientB.remoteParticipants.values.single.identity;
    expect(aIdentity, isNot(_userB), reason: "A's identity must differ from B's");
    await _until(
      () => clientA.remoteParticipants[_userB] != null,
      reason: 'client A never observed client B as a remote participant',
    );
    expect(clientA.remoteParticipants.length, 1, reason: 'A should see exactly B');

    // 3. Presenter AUTHORITY for A via the real backend (claim the slot if the
    //    join grant did not already carry it). This is the server capability
    //    (states 1 & 2) — and it must NOT by itself create an active share.
    if (!clientA.screenAuthorized) {
      await repoA.claimPresenter(_sessionId);
      await _until(
        () => clientA.screenAuthorized,
        reason: 'A was not authorized to present after claimPresenter (no reconnect)',
      );
    }
    expect(clientA.screenAuthorized, isTrue);
    // Authority alone is NOT a publishing track — asserted on BOTH sides.
    expect(
      clientA.publication.screenShareOn,
      isFalse,
      reason: 'presenter authority must not imply an active LOCAL screen share',
    );
    expect(
      clientB.remoteParticipants[aIdentity]?.screenSharing,
      isFalse,
      reason: 'presenter authority must not imply an active REMOTE screen share',
    );

    // State 3 — a REAL display-capture source must be obtainable here. Probed
    // DIRECTLY (diagnostic) so the exact DOM outcome is logged and this fact is
    // asserted on its own, before — and distinct from — an actually-published
    // track. If capture is impossible in this environment, it fails HERE with a
    // precise reason (never a false pass downstream).
    final probeTracks = await _probeDisplayMediaTrackCount();
    // ignore: avoid_print
    print('LKDIAG screen-probe[video:true]: videoTracks=$probeTracks');
    expect(
      probeTracks,
      greaterThanOrEqualTo(1),
      reason: 'no real display-capture source in this environment '
          '(getDisplayMedia returned no video track)',
    );

    // 4. REAL browser display capture → the production publish path. With a real
    //    display + auto-selected source this acquires a genuine screen-capture
    //    track and publishes it; with none it throws (no false pass).
    await clientA.setScreenShareEnabled(true);
    // State 4 — the LOCAL SDK reports an actually-published screen-share track
    // (isScreenShareEnabled(): published AND unmuted), not a command result.
    await _until(
      () => clientA.publication.screenShareOn,
      reason:
          "A's screen-share track did not publish — a real capture source was "
          'not obtained (is a real/virtual display present?)',
    );
    // State 5 — the REMOTE client actually receives the real screen-share
    // publication/track and reconciles its application state.
    await _until(
      () => clientB.remoteParticipants[aIdentity]?.screenSharing == true,
      reason: "B did not receive A's real remote screen-share publication",
    );

    // Local and remote publication state stay SEPARATE:
    //  - B is not sharing (its own local publication is off);
    expect(
      clientB.publication.screenShareOn,
      isFalse,
      reason: "A's share must not appear as B's LOCAL publication",
    );
    //  - A's view of B does not show B sharing (A's own share is local only);
    expect(
      clientA.remoteParticipants[_userB]?.screenSharing ?? false,
      isFalse,
      reason: "A's own local share must not surface as B's REMOTE share",
    );

    // 5. STOP → the remote track ends and BOTH sides reconcile to inactive
    //    (state 6), and the participant stays connected (only the share stops).
    await clientA.setScreenShareEnabled(false);
    await _until(
      () => !clientA.publication.screenShareOn,
      reason: "A's local screen share did not stop",
    );
    await _until(
      () => clientB.remoteParticipants[aIdentity]?.screenSharing == false,
      reason: 'B still shows A sharing after A stopped',
    );
    expect(
      clientA.state,
      isA<LiveMediaConnected>(),
      reason: 'stopping the screen share must not drop the connection',
    );
    // A remains a present remote on B (departure is covered elsewhere).
    expect(clientB.remoteParticipants[aIdentity], isNotNull);

    // 6. REVOKE presenter authority → authorization is withdrawn live (no
    //    reconnect) with NO stale active-share state left on either side.
    await repoA.stopPresenter(_sessionId);
    await _until(
      () => !clientA.screenAuthorized,
      reason: 'presenter revoke did not withdraw screen authorization',
    );
    expect(clientA.publication.screenShareOn, isFalse);
    expect(clientB.remoteParticipants[aIdentity]?.screenSharing ?? false, isFalse);
  }, timeout: const Timeout(Duration(seconds: 180)));
}
