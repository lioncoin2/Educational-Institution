// Real TWO-CLIENT LiveKit WEB end-to-end (Sprint 12).
//
// Two INDEPENDENT LiveKit clients, each the production adapter
// (LiveKitLiveMediaClient → SdkLiveKitRoomPort → livekit_client), connect to the
// SAME real LiveKit room with DISTINCT backend-authorized identities:
//
//   Client A = the owner/host (LIVEKIT_E2E_ACCESS_TOKEN)
//   Client B = a second STUDENT participant (LIVEKIT_E2E_ACCESS_TOKEN_B),
//              created, STUDENT-granted, activated and added to the community by
//              the provisioning fixture through the real admin API.
//
// It proves the remote path Sprint 11 could only cover with fakes:
//
//   B publishes a real SDK mic track
//     → A receives real remote SDK events
//     → the adapter translates them
//     → LiveKitLiveMediaClient reconciles A's remote-participant state
//     → client.remoteParticipants[B] reflects presence + audio.
//
// Assertions are at the APPLICATION boundary (each client's remoteParticipants),
// not SDK internals. The audio INPUT may be a fake device in headless CI, but
// the connection, publication, subscription and remote events are REAL.
//
// RUN (web only; needs Chrome and a backend in real LiveKit mode):
//
//   flutter test test/e2e/ --platform chrome \
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
  Duration timeout = const Duration(seconds: 25),
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

void main() {
  // The browser E2E needs a live Flutter binding before livekit_client touches
  // Flutter state during Room.connect (as in livekit_web_e2e_test.dart).
  TestWidgetsFlutterBinding.ensureInitialized();
  ConnectivityPlusWebPlugin.registerWith(webPluginRegistrar);

  test('two independent clients observe each other across a real LiveKit room', () async {
    if (_baseUrl.isEmpty ||
        _tokenA.isEmpty ||
        _tokenB.isEmpty ||
        _sessionId.isEmpty ||
        _userB.isEmpty) {
      markTestSkipped(
        'two-client LiveKit E2E not configured — set LIVEKIT_E2E_BASE_URL, '
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
    // Deterministic cleanup on EVERY path (success or failure): disconnect then
    // dispose both clients, then close both HTTP clients.
    addTearDown(() async {
      await clientA.disconnect();
      await clientB.disconnect();
      await clientA.dispose();
      await clientB.dispose();
      httpA.close();
      httpB.close();
    });

    final repoA = _repoFor(_tokenA, httpA);
    final repoB = _repoFor(_tokenB, httpB);

    // 1. Separate, backend-authorized grants for the SAME session/room.
    final grantA = await repoA.join(_sessionId);
    final grantB = await repoB.join(_sessionId);
    expect(grantA.sessionId, isNotEmpty);
    expect(grantB.sessionId, isNotEmpty);

    // 2. Connect both independent clients and assert each reaches connected.
    await _awaitConnected(clientA, grantA);
    await _awaitConnected(clientB, grantB);

    // 3. Each client observes the other as a remote participant. A (the owner)
    //    must see exactly B (keyed by B's user id = the LiveKit identity).
    await _until(
      () => clientA.remoteParticipants[_userB] != null,
      reason: 'client A never observed client B as a remote participant',
    );
    expect(clientA.remoteParticipants.length, 1, reason: 'A should see exactly B');
    expect(clientA.remoteParticipants.byIdentity.keys, contains(_userB));
    await _until(
      () => clientB.remoteParticipants.length == 1,
      reason: 'client B never observed client A as a remote participant',
    );
    // B's one remote is A, a DISTINCT identity from B itself.
    expect(clientB.remoteParticipants.byIdentity.keys, isNot(contains(_userB)));

    // 4. No duplicate remote entry under repeated/steady observation.
    expect(clientA.remoteParticipants.length, 1);

    // 5. B publishes real microphone audio → A's remote audio reconciles to live.
    await clientB.setMicrophoneEnabled(true);
    await _until(
      () => clientA.remoteParticipants[_userB]?.audio == LiveRemoteAudio.live,
      reason: "B's microphone publication did not reach A as live remote audio",
    );
    // B's LOCAL publication is its own state — never confused with A's remote view.
    expect(clientB.publication.microphoneOn, isTrue);

    // 6. B mutes → A's remote audio leaves live; B unmutes → it returns.
    await clientB.setMicrophoneEnabled(false);
    await _until(
      () => clientA.remoteParticipants[_userB]?.audio != LiveRemoteAudio.live,
      reason: "B's mute did not reconcile on A",
    );
    await clientB.setMicrophoneEnabled(true);
    await _until(
      () => clientA.remoteParticipants[_userB]?.audio == LiveRemoteAudio.live,
      reason: "B's unmute did not reconcile on A",
    );

    // 7. B departs → A drops B within a bounded timeout; no stale audio/screen.
    await clientB.disconnect();
    await _until(
      () => clientA.remoteParticipants[_userB] == null,
      reason: 'A did not drop B after B disconnected',
    );
    expect(clientA.remoteParticipants.length, 0);
  }, timeout: const Timeout(Duration(seconds: 120)));
}
