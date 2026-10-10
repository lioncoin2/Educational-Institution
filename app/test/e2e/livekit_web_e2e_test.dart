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
// logged; the SDK diagnostics below are redacted before printing.
@TestOn('browser')
library;

import 'dart:async';

// connectivity_plus's official web implementation entry point (the plugin's
// declared web `fileName`). `flutter test --platform chrome` does NOT run
// Flutter's generated web plugin registrant, so without this the SDK's
// Utils.getNetworkType → Connectivity().checkConnectivity() hangs before
// signalling. We invoke the SAME registration the generated registrant would,
// installing the real web impl (DartHtmlConnectivityPlugin) — not a fake. The
// production web app is unaffected: it runs the generated registrant normally.
// ignore: implementation_imports, depend_on_referenced_packages
import 'package:connectivity_plus/src/connectivity_plus_web.dart';
import 'package:flutter_test/flutter_test.dart';
// Flutter SDK web plugin registry, used to invoke the web registerWith above.
// ignore: depend_on_referenced_packages
import 'package:flutter_web_plugins/flutter_web_plugins.dart';
import 'package:http/http.dart' as http;
// livekit_client's logging backend (transitive). Its records are the permanent
// failure diagnostic for the connect/signalling/media phases; redacted on print.
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
/// access_token/token/secret/authorization value. A signalling URL's scheme,
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
  // has not yet been initialized". The standard flutter_test initializer;
  // required here, and introduces no custom binding.
  TestWidgetsFlutterBinding.ensureInitialized();

  // Register connectivity_plus's official web implementation, because
  // `flutter test --platform chrome` does not run Flutter's generated web plugin
  // registrant. Required: livekit_client awaits Connectivity().checkConnectivity()
  // (ungated on web) in Utils.getNetworkType before signalling, and without the
  // real web impl that call hangs. Installs DartHtmlConnectivityPlugin — not a
  // fake. See the import note above.
  ConnectivityPlusWebPlugin.registerWith(webPluginRegistrar);

  test('Flutter → /join → LiveKit room connects, publishes per grant, disconnects', () async {
    if (_baseUrl.isEmpty || _accessToken.isEmpty || _sessionId.isEmpty) {
      markTestSkipped(
        'LiveKit web E2E not configured — set LIVEKIT_E2E_BASE_URL, '
        'LIVEKIT_E2E_ACCESS_TOKEN and LIVEKIT_E2E_SESSION_ID (--dart-define).',
      );
      return;
    }

    // Permanent failure diagnostic: capture livekit_client's own logs (the
    // signalling URL, SignalConnected, join response, SDP/ICE, any Connect Error,
    // disconnect reason) so a future connection / signalling / room-join / media /
    // unexpected-disconnect failure is actionable from CI. Every line is redacted
    // — no token is ever printed. Records are buffered and re-emitted on teardown
    // so even a hang (where mid-test prints can be dropped by the browser console
    // → test-runner bridge) still surfaces the full trace.
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
    addTearDown(() {
      // ignore: avoid_print
      print('LKDIAG flush (${diagLog.length} records):');
      for (final line in diagLog) {
        // ignore: avoid_print
        print(line);
      }
    });

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

    await client.connect(grant);
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
