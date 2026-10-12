// Real THREE-CLIENT LiveKit lifecycle end-to-end (Sprint 14).
//
// Extends the Sprint 12 two-client harness to THREE independent production
// clients to verify multi-participant identity and departure behaviour against
// the real pinned LiveKit 1.13.7 — the application-boundary question Sprint 14
// asks: does every client converge to the authoritative room state, with no
// duplicate identities, and does ONE participant leaving remove only that one
// while the rest (and their live media) stay intact?
//
//   Client A = the owner/host (LIVEKIT_E2E_ACCESS_TOKEN)
//   Client B = a STUDENT participant (LIVEKIT_E2E_ACCESS_TOKEN_B / _USER_B)
//   Client C = a second STUDENT participant (LIVEKIT_E2E_ACCESS_TOKEN_C /_USER_C)
//
// All three are the production adapter (LiveKitLiveMediaClient →
// SdkLiveKitRoomPort → livekit_client), connected to the SAME real room with
// DISTINCT backend-authorized identities (B and C created by the provisioning
// fixture through the real admin API — no permission invented).
//
// Assertions are at the APPLICATION boundary (each client's remoteParticipants),
// never SDK internals, with bounded event-driven waits. This test does NOT end
// the session (C only leaves); session termination is a separate harness.
//
// RUN (web only; needs Chrome and a backend in real LiveKit mode):
//
//   flutter test test/e2e/livekit_three_client_e2e_test.dart --platform chrome \
//     --dart-define=LIVEKIT_E2E_BASE_URL=http://127.0.0.1:3000 \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN=<owner token> \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN_B=<participant B token> \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN_C=<participant C token> \
//     --dart-define=LIVEKIT_E2E_SESSION_ID=<active live session id> \
//     --dart-define=LIVEKIT_E2E_USER_B=<participant B user id> \
//     --dart-define=LIVEKIT_E2E_USER_C=<participant C user id>
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
const _tokenC = String.fromEnvironment('LIVEKIT_E2E_ACCESS_TOKEN_C');
const _sessionId = String.fromEnvironment('LIVEKIT_E2E_SESSION_ID');
const _userB = String.fromEnvironment('LIVEKIT_E2E_USER_B');
const _userC = String.fromEnvironment('LIVEKIT_E2E_USER_C');

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

void main() {
  // The browser E2E needs a live Flutter binding before livekit_client touches
  // Flutter state during Room.connect (as in livekit_web_e2e_test.dart).
  TestWidgetsFlutterBinding.ensureInitialized();
  ConnectivityPlusWebPlugin.registerWith(webPluginRegistrar);

  test('three independent clients converge; one leaving removes only that one', () async {
    if (_baseUrl.isEmpty ||
        _tokenA.isEmpty ||
        _tokenB.isEmpty ||
        _tokenC.isEmpty ||
        _sessionId.isEmpty ||
        _userB.isEmpty ||
        _userC.isEmpty) {
      markTestSkipped(
        'three-client LiveKit E2E not configured — set LIVEKIT_E2E_BASE_URL, '
        'LIVEKIT_E2E_ACCESS_TOKEN, LIVEKIT_E2E_ACCESS_TOKEN_B, '
        'LIVEKIT_E2E_ACCESS_TOKEN_C, LIVEKIT_E2E_SESSION_ID, LIVEKIT_E2E_USER_B '
        'and LIVEKIT_E2E_USER_C (--dart-define).',
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

    // B and C are DISTINCT backend identities.
    expect(_userB, isNot(_userC), reason: 'B and C must be distinct identities');

    final httpA = http.Client();
    final httpB = http.Client();
    final httpC = http.Client();
    final clientA = LiveKitLiveMediaClient();
    final clientB = LiveKitLiveMediaClient();
    final clientC = LiveKitLiveMediaClient();
    // Deterministic cleanup on EVERY path: disconnect then dispose all three
    // clients, then close all HTTP clients. (C may already be disconnected.)
    addTearDown(() async {
      await clientA.disconnect();
      await clientB.disconnect();
      await clientC.disconnect();
      await clientA.dispose();
      await clientB.dispose();
      await clientC.dispose();
      httpA.close();
      httpB.close();
      httpC.close();
    });

    final repoA = _repoFor(_tokenA, httpA);
    final repoB = _repoFor(_tokenB, httpB);
    final repoC = _repoFor(_tokenC, httpC);

    // 1. Separate backend-authorized grants for the SAME session/room; connect.
    final grantA = await repoA.join(_sessionId);
    final grantB = await repoB.join(_sessionId);
    final grantC = await repoC.join(_sessionId);
    await _awaitConnected(clientA, grantA);
    await _awaitConnected(clientB, grantB);
    await _awaitConnected(clientC, grantC);

    // 2. Each client observes exactly the OTHER two as remote participants —
    //    distinct identities, no duplicate, nobody absent.
    //    A (owner) sees exactly {B, C}.
    await _until(
      () => clientA.remoteParticipants.length == 2,
      reason: 'A never observed both B and C',
    );
    expect(clientA.remoteParticipants.byIdentity.keys, containsAll(<String>[_userB, _userC]));
    //    B sees exactly two, including C, never itself (B).
    await _until(
      () => clientB.remoteParticipants.length == 2,
      reason: 'B never observed both A and C',
    );
    expect(clientB.remoteParticipants.byIdentity.keys, contains(_userC));
    expect(clientB.remoteParticipants.byIdentity.keys, isNot(contains(_userB)));
    //    C sees exactly two, including B, never itself (C).
    await _until(
      () => clientC.remoteParticipants.length == 2,
      reason: 'C never observed both A and B',
    );
    expect(clientC.remoteParticipants.byIdentity.keys, contains(_userB));
    expect(clientC.remoteParticipants.byIdentity.keys, isNot(contains(_userC)));

    // 3. B publishes REAL microphone audio → BOTH other clients reconcile B's
    //    remote audio to live (multi-subscriber remote-audio reconciliation).
    await clientB.setMicrophoneEnabled(true);
    await _until(
      () => clientA.remoteParticipants[_userB]?.audio == LiveRemoteAudio.live,
      reason: "B's microphone did not reach A as live remote audio",
    );
    await _until(
      () => clientC.remoteParticipants[_userB]?.audio == LiveRemoteAudio.live,
      reason: "B's microphone did not reach C as live remote audio",
    );
    expect(clientB.publication.microphoneOn, isTrue);

    // 4. C departs → A and B drop ONLY C within a bounded timeout; A and B still
    //    observe each other, and B's live microphone on A is UNAFFECTED.
    await clientC.disconnect();
    await _until(
      () => clientA.remoteParticipants[_userC] == null,
      reason: 'A did not drop C after C left',
    );
    expect(clientA.remoteParticipants.length, 1, reason: 'A should now see only B');
    expect(clientA.remoteParticipants[_userB], isNotNull, reason: 'A must still see B');
    await _until(
      () => clientB.remoteParticipants[_userC] == null,
      reason: 'B did not drop C after C left',
    );
    expect(clientB.remoteParticipants.length, 1, reason: 'B should now see only A');
    // B's media survives an unrelated participant leaving.
    expect(
      clientA.remoteParticipants[_userB]?.audio,
      LiveRemoteAudio.live,
      reason: "C leaving must not disturb B's remote audio on A",
    );
  }, timeout: const Timeout(Duration(seconds: 180)));
}
