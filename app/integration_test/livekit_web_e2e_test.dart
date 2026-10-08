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
// It is NOT part of the normal suite (`flutter test` scans test/, not
// integration_test/) and it does NOT activate LiveKit as the app provider —
// it wires LiveKitLiveMediaClient directly, test-only.
//
// RUN (web only; needs Chrome and a reachable backend in real LiveKit mode):
//
//   flutter test integration_test/livekit_web_e2e_test.dart --platform chrome \
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

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_live_media_client.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/http/http_live_repository.dart';

const _baseUrl = String.fromEnvironment('LIVEKIT_E2E_BASE_URL');
const _accessToken = String.fromEnvironment('LIVEKIT_E2E_ACCESS_TOKEN');
const _sessionId = String.fromEnvironment('LIVEKIT_E2E_SESSION_ID');

void main() {
  test('Flutter → /join → LiveKit room connects, publishes per grant, disconnects', () async {
    if (_baseUrl.isEmpty || _accessToken.isEmpty || _sessionId.isEmpty) {
      markTestSkipped(
        'LiveKit web E2E not configured — set LIVEKIT_E2E_BASE_URL, '
        'LIVEKIT_E2E_ACCESS_TOKEN and LIVEKIT_E2E_SESSION_ID (--dart-define).',
      );
      return;
    }

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
