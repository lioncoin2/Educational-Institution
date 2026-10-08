// Real LiveKit WEB end-to-end transport harness (P7b).
//
// Proves the real chain on a browser against a real server:
//
//   HttpLiveRepository.join(sessionId)   → POST /live/sessions/:id/join
//     → LiveMediaGrant
//     → LiveKitLiveMediaClient.connect(grant)   (SdkLiveKitRoomPort → livekit_client)
//     → LiveKit Server 1.13.7 → a real Room connection
//     → adapter reports LiveMediaConnected
//
// It lives under test/ (not integration_test/, which `flutter test --platform
// chrome` refuses) but is excluded from the normal VM `flutter test` run by
// @TestOn('browser'); it does NOT activate LiveKit as the app provider — it
// wires LiveKitLiveMediaClient directly, test-only.
//
// RUN (web only; needs Chrome and a reachable backend in real LiveKit mode):
//
//   flutter test test/e2e/livekit_web_e2e_test.dart --platform chrome \
//     --dart-define=LIVEKIT_E2E_BASE_URL=http://127.0.0.1:3000 \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN=<backend session access token> \
//     --dart-define=LIVEKIT_E2E_SESSION_ID=<an active live session id>
//
// Credentials come ONLY from --dart-define at run time — never hardcoded,
// never committed, never printed. With any of them unset the test SKIPS, so
// the harness is safe to keep in the tree. The grant and its token are never
// logged or put in failure output.
@TestOn('browser')
library;

import 'dart:async';

// package:connectivity_plus is a transitive dependency (via livekit_client);
// imported here solely to confirm the suspected pre-signalling hang: the SDK's
// Utils.buildUri → getNetworkType awaits Connectivity().checkConnectivity() on
// web, ungated. Not an application dependency.
// ignore: depend_on_referenced_packages
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_test/flutter_test.dart';
// package:flutter_webrtc is a transitive dependency (via livekit_client);
// imported here solely for a TEST-ONLY WebRTC readiness probe that calls the
// same public createPeerConnection the SDK engine uses. Not an app dependency.
// ignore: depend_on_referenced_packages
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;
import 'package:http/http.dart' as http;
// package:logging is livekit_client's logging backend (a transitive dependency);
// imported here solely for TEST-ONLY diagnostics, to read the SDK's own
// signalling logs. Not an application dependency.
// ignore: depend_on_referenced_packages
import 'package:logging/logging.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_live_media_client.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/http/http_live_repository.dart';

const _baseUrl = String.fromEnvironment('LIVEKIT_E2E_BASE_URL');
const _accessToken = String.fromEnvironment('LIVEKIT_E2E_ACCESS_TOKEN');
const _sessionId = String.fromEnvironment('LIVEKIT_E2E_SESSION_ID');

/// Redacts credentials before any diagnostic line is printed: any JWT (three
/// base64url segments — the LiveKit/access token is one) and any
/// access_token/token/secret/authorization value. The signalling URL's scheme,
/// host and path are preserved; its token is not.
String _redactDiagnostics(String input) => input
    .replaceAll(
      RegExp(r'[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}'),
      '<jwt-redacted>',
    )
    .replaceAllMapped(
      RegExp(
        r'(access_token|token|secret|authorization)=[^&\s"]+',
        caseSensitive: false,
      ),
      (m) => '${m[1]}=<redacted>',
    );

void main() {
  // The browser E2E needs a live Flutter binding before livekit_client touches
  // Flutter state during Room.connect — without it the SDK aborts with "Binding
  // has not yet been initialized" and never opens the signalling WebSocket. This
  // is the standard flutter_test initializer; no custom binding is introduced.
  TestWidgetsFlutterBinding.ensureInitialized();

  test('Flutter → /join → LiveKit room connects, publishes per grant, disconnects', () async {
    if (_baseUrl.isEmpty || _accessToken.isEmpty || _sessionId.isEmpty) {
      markTestSkipped(
        'LiveKit web E2E not configured — set LIVEKIT_E2E_BASE_URL, '
        'LIVEKIT_E2E_ACCESS_TOKEN and LIVEKIT_E2E_SESSION_ID (--dart-define).',
      );
      return;
    }

    // TEST-ONLY DIAGNOSTICS (observability; changes no connection parameter and
    // no test behavior). livekit_client logs through package:logging; routing
    // its root stream to the test output surfaces the exact signalling URL the
    // SDK dials and every WebSocket/engine event and error — so CI can see what
    // Chrome does with the socket before it would reach LiveKit. Every line is
    // redacted, so no token or credential is ever printed.
    Logger.root.level = Level.ALL;
    final diagLog = <String>[];
    final diagnostics = Logger.root.onRecord.listen((record) {
      final error = record.error == null
          ? ''
          : ' | error=${_redactDiagnostics('${record.error}')}';
      final line =
          'LKDIAG ${record.level.name} ${record.loggerName}: '
          '${_redactDiagnostics(record.message)}$error';
      diagLog.add(line);
      // ignore: avoid_print
      print(line);
    });
    addTearDown(diagnostics.cancel);

    // Re-emit the buffered SDK records as one contiguous block. The immediate
    // prints above can be dropped by the browser console → test-runner bridge
    // when the connect await fails mid-flight (the prior run captured only the
    // teardown logs); flushing the buffer at settled points — around the connect
    // boundary and on teardown — reliably surfaces the full connect-phase trace.
    void flushDiag(String marker) {
      // ignore: avoid_print
      print('LKFLUSH[$marker] ${diagLog.length} records:');
      for (final line in diagLog) {
        // ignore: avoid_print
        print(line);
      }
      // ignore: avoid_print
      print('LKFLUSH[$marker] end');
    }

    addTearDown(() => flushDiag('teardown'));

    // An authenticated client against the real backend. The access token is the
    // backend session token supplied at run time; the store redacts it, and it
    // never leaves this process.
    final httpClient = http.Client();
    final tokenStore = InMemoryTokenStore();
    await tokenStore.write(
      const Tokens(accessToken: _accessToken, refreshToken: _accessToken),
    );
    final api = ApiClient(
      baseUri: Uri.parse(_baseUrl.endsWith('/') ? _baseUrl : '$_baseUrl/'),
      httpClient: httpClient,
      tokenStore: tokenStore,
    );
    final repository = HttpLiveRepository(api);
    final client = LiveKitLiveMediaClient();
    addTearDown(() async {
      await client.dispose();
      httpClient.close();
    });

    // 1. Real backend join → a real media grant. Assert only non-secret facts;
    //    never print the grant or its token.
    final grant = await repository.join(_sessionId);
    expect(grant.sessionId, isNotEmpty);
    expect(grant.url, isNotEmpty);

    // 2. Connect to the real LiveKit room, bounded. Register the terminal-state
    //    future BEFORE connecting so a fast connect is not missed.
    final settled = Completer<LiveMediaState>();
    final sub = client.states.listen((state) {
      if (!settled.isCompleted &&
          (state is LiveMediaConnected ||
              state is LiveMediaFailed ||
              state is LiveMediaDisconnected)) {
        settled.complete(state);
      }
    });
    addTearDown(sub.cancel);

    // Proof of the fix: the Flutter binding the LiveKit SDK relies on is live
    // BEFORE connect (accessing `.instance` would itself throw "Binding has not
    // yet been initialized" otherwise — the exact prior failure).
    expect(TestWidgetsFlutterBinding.instance, isNotNull);

    // WebRTC readiness probe (diagnostic only; supported public API). On web the
    // SDK performs NO explicit WebRTC init: LiveKitClient.initialize() is a
    // no-op on web, WebRTC.initialize() throws UnimplementedError('not supported
    // on web'), and the web WebRTC class exposes NO public "initialized" state.
    // So we exercise the same public call the engine makes before signalling —
    // rtc.createPeerConnection — bounded, to record whether the browser WebRTC
    // layer is usable BEFORE Room.connect. The probe PC is closed immediately
    // and does not touch the real connect that follows.
    String webrtcProbe;
    try {
      final pc = await rtc
          .createPeerConnection(<String, dynamic>{})
          .timeout(const Duration(seconds: 10));
      webrtcProbe = 'usable (createPeerConnection returned)';
      await pc.close();
    } on TimeoutException {
      webrtcProbe = 'HANG (createPeerConnection still pending after 10s)';
    } catch (e) {
      webrtcProbe = 'error (${e.runtimeType}: ${_redactDiagnostics('$e')})';
    }
    final webrtcLine =
        'LKWEBRTC Flutter binding: initialized | public WebRTC state API: '
        'none on web | createPeerConnection probe: $webrtcProbe';
    diagLog.add(webrtcLine);
    // ignore: avoid_print
    print(webrtcLine);

    // CONFIRMATION probe (diagnostic only): call the exact public API the SDK's
    // Utils.buildUri → getNetworkType awaits on web (Connectivity 7.3.2), with a
    // strict 10s bound, immediately before client.connect. This does not touch
    // Room.connect. Distinguishes usable / TIMEOUT (hang) / ERROR.
    String connectivityProbe;
    try {
      final result = await Connectivity().checkConnectivity().timeout(
        const Duration(seconds: 10),
      );
      connectivityProbe = 'usable ($result)';
    } on TimeoutException {
      connectivityProbe = 'TIMEOUT';
    } catch (e) {
      connectivityProbe = 'ERROR ${e.runtimeType}: ${_redactDiagnostics('$e')}';
    }
    final connectivityLine =
        'LKCONNECTIVITY checkConnectivity: $connectivityProbe';
    diagLog.add(connectivityLine);
    // ignore: avoid_print
    print(connectivityLine);

    // Phase markers distinguish a failure BEFORE, INSIDE, or AFTER connect; the
    // finally flushes the SDK trace so the connect phase is captured even when
    // the await fails. Behavior is unchanged — the same single connect call,
    // and the same error is rethrown.
    // ignore: avoid_print
    print('LKPHASE before client.connect');
    try {
      await client.connect(grant);
      // ignore: avoid_print
      print('LKPHASE after client.connect returned');
    } catch (error) {
      // ignore: avoid_print
      print(
        'LKPHASE client.connect threw ${error.runtimeType}: '
        '${_redactDiagnostics('$error')}',
      );
      rethrow;
    } finally {
      flushDiag('after-connect');
    }
    final result = await settled.future.timeout(const Duration(seconds: 20));
    // The critical assertion: a REAL room connection, not a 200 from /join.
    expect(
      result,
      isA<LiveMediaConnected>(),
      reason: 'the LiveKit room did not reach connected',
    );

    // 3. Publish controls, each gated by the grant (no backend authz here).
    if (grant.microphone) {
      await client.setMicrophoneEnabled(true);
      await client.setMicrophoneEnabled(false);
    }
    if (!grant.screen) {
      // The contract: with no screen grant, the adapter refuses — proven even
      // without a browser screen source.
      await expectLater(
        client.setScreenShareEnabled(true),
        throwsA(isA<LiveMediaException>()),
      );
    }

    // 4. Explicit local disconnect → idle (never a remote kick/duplicate).
    await client.disconnect();
    expect(client.state, isA<LiveMediaIdle>());
  }, timeout: const Timeout(Duration(seconds: 60)));
}
