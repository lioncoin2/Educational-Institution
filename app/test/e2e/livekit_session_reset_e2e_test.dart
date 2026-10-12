// Real SESSION-RESET recovery end-to-end (Sprint 15).
//
// Verifies the one reconnection scenario this harness CAN induce deterministically
// against the real pinned LiveKit 1.13.7: a moderator RESETS the media room (a new
// room is ensured and the old one deleted, epoch bump — the session stays LIVE),
// a connected client observes the authoritative `roomDeleted` drop, and both
// clients RECOVER to the NEW room via a fresh `/join` with CLEAN state — no stale
// participant from the old room, no duplicate, correct reconvergence.
//
// This is NOT the SDK's internal network reconnect (Reconnecting/Reconnected on a
// transient signal blip), which cannot be induced deterministically here and
// stays NOT-VERIFIED E2E (documented in docs/p8-live-media-verification.md). It
// IS the application-level recovery after a room-level drop, which is real and
// inducible via the reset endpoint.
//
//   Client A = the owner/host (also a moderator — resets the room).
//   Client B = a STUDENT participant (LIVEKIT_E2E_ACCESS_TOKEN_B / _USER_B).
//
// Assertions are at the application boundary (each client's state and
// remoteParticipants), bounded event-driven waits. This test resets the room but
// does NOT end the session; a fresh join after reset still succeeds.
//
// RUN (web only; needs Chrome and a backend in real LiveKit mode):
//
//   flutter test test/e2e/livekit_session_reset_e2e_test.dart --platform chrome \
//     --dart-define=LIVEKIT_E2E_BASE_URL=http://127.0.0.1:3000 \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN=<owner token> \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN_B=<participant B token> \
//     --dart-define=LIVEKIT_E2E_SESSION_ID=<active live session id> \
//     --dart-define=LIVEKIT_E2E_USER_B=<participant B user id>
//
// With any required define unset the test SKIPS. No token is ever logged.
@TestOn('browser')
library;

import 'dart:async';

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

String _redact(String input) => input
    .replaceAll(
      RegExp(r'[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}'),
      '<jwt-redacted>',
    )
    .replaceAllMapped(
      RegExp(r'(access_token|token|secret|authorization)=[^&\s"]+', caseSensitive: false),
      (m) => '${m[1]}=<redacted>',
    );

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

/// Fresh-joins the session and connects [client] to whatever room is current
/// NOW (so after a reset this targets the NEW room), asserting it reaches
/// connected. Registers the terminal-state listener BEFORE connecting.
Future<void> _joinAndConnect(HttpLiveRepository repo, LiveKitLiveMediaClient client) async {
  final grant = await repo.join(_sessionId);
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

bool _isRoomDeleted(LiveMediaState s) =>
    s is LiveMediaDisconnected && s.reason == LiveMediaDisconnectReason.roomDeleted;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  ConnectivityPlusWebPlugin.registerWith(webPluginRegistrar);

  test('a room reset drops connected clients; both recover to the new room, clean', () async {
    if (_baseUrl.isEmpty ||
        _tokenA.isEmpty ||
        _tokenB.isEmpty ||
        _sessionId.isEmpty ||
        _userB.isEmpty) {
      markTestSkipped(
        'session-reset LiveKit E2E not configured — set LIVEKIT_E2E_BASE_URL, '
        'LIVEKIT_E2E_ACCESS_TOKEN, LIVEKIT_E2E_ACCESS_TOKEN_B, '
        'LIVEKIT_E2E_SESSION_ID and LIVEKIT_E2E_USER_B (--dart-define).',
      );
      return;
    }

    Logger.root.level = Level.ALL;
    final sub = Logger.root.onRecord.listen((r) {
      // ignore: avoid_print
      print('LKDIAG ${r.level.name} ${r.loggerName}: ${_redact(r.message)}');
    });
    addTearDown(sub.cancel);

    final httpA = http.Client();
    final httpB = http.Client();
    final clientA = LiveKitLiveMediaClient();
    final clientB = LiveKitLiveMediaClient();
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

    // 1. Both connect to the current room; A observes B.
    await _joinAndConnect(repoA, clientA);
    await _joinAndConnect(repoB, clientB);
    await _until(
      () => clientA.remoteParticipants[_userB] != null,
      reason: 'A never observed B before the reset',
    );

    // 2. The owner (a moderator) RESETS the room — a new room is ensured and the
    //    old one deleted; the session stays live.
    final didReset = await repoA.resetRoom(_sessionId);
    expect(didReset, isTrue, reason: 'the reset should report success');

    // 3. Both connected clients observe the authoritative terminal drop of the
    //    OLD room (real SDK roomDeleted via the adapter) — not a silent hang.
    await _until(
      () => _isRoomDeleted(clientA.state),
      reason: 'A did not observe roomDeleted after the reset',
    );
    await _until(
      () => _isRoomDeleted(clientB.state),
      reason: 'B did not observe roomDeleted after the reset',
    );
    // The old room is gone, so A no longer tracks B from it.
    expect(clientA.remoteParticipants[_userB], isNull);

    // 4. RECOVERY: a fresh join reaches the NEW room; connect() resets local and
    //    remote state, so the new connection starts clean (no stale old-room
    //    participants) — then both reconverge.
    await _joinAndConnect(repoA, clientA);
    await _joinAndConnect(repoB, clientB);

    // 5. In the NEW room A sees EXACTLY B again — reconverged, no duplicate, no
    //    stale ghost from the previous room; B sees exactly A.
    await _until(
      () => clientA.remoteParticipants[_userB] != null,
      reason: 'A did not re-observe B in the new room after recovery',
    );
    expect(clientA.remoteParticipants.length, 1, reason: 'A should see exactly B, once');
    await _until(
      () => clientB.remoteParticipants.length == 1,
      reason: 'B did not re-observe A in the new room after recovery',
    );
    expect(clientB.remoteParticipants.byIdentity.keys, isNot(contains(_userB)));
    expect(clientA.state, isA<LiveMediaConnected>());
    expect(clientB.state, isA<LiveMediaConnected>());
  }, timeout: const Timeout(Duration(seconds: 150)));
}
