// Real TRANSIENT-RECONNECT LiveKit end-to-end (Sprint 18) — DIAGNOSTIC.
//
// Proves (or disproves) the one capability every prior sprint left NOT VERIFIED
// E2E: a genuine transient transport interruption of the SAME LiveKit room —
// the SDK enters RoomReconnecting and recovers via RoomReconnected, WITHOUT the
// room being deleted/recreated (that is the separate roomDeleted path, already
// covered by the reset/session-end E2Es).
//
// The interruption is induced EXTERNALLY by the dedicated diagnostic workflow
// (`.github/workflows/live-reconnect-diagnostic.yml`), which freezes the LiveKit
// container with `docker compose pause livekit` for a bounded window, then
// `unpause`s it. SIGSTOP freezes the process but PRESERVES the room in memory, so
// on resume the clients reconnect to the SAME room (unlike restart/stop, which
// lose it). This test does NOT control the pause; it OBSERVES the resulting real
// SDK lifecycle through the production adapter.
//
//   Client A = the owner/host; Client B = a STUDENT participant.
//
// VERIFIED by this test (fails loudly, never fakes): a genuine transient
// interruption makes the SDK enter RoomReconnecting on the SAME room — NOT a
// terminal roomDeleted drop. The subsequent FULL room recovery (RoomReconnected
// → connected) is OBSERVED and RECORDED best-effort, NOT asserted: in this
// headless, no-TURN CI harness the signal reconnects but full media/ICE recovery
// is not guaranteed in-window (see docs/p8-live-media-verification.md, Sprint 18
// — NOT VERIFIED E2E). A recovery that did not happen is never faked as success.
//
// RUN: only via the diagnostic workflow (it needs the external pause). With any
// required define unset the test SKIPS. No token is ever logged.
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

/// Polls [condition] until true or the bounded [timeout] — for genuinely async
/// SDK → adapter transitions. Never an unbounded sleep; FAILS loudly on timeout.
Future<void> _until(
  bool Function() condition, {
  required String reason,
  Duration timeout = const Duration(seconds: 60),
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
  TestWidgetsFlutterBinding.ensureInitialized();
  ConnectivityPlusWebPlugin.registerWith(webPluginRegistrar);

  test('a transient interruption triggers a real SDK reconnect of the same room (not a terminal drop)', () async {
    if (_baseUrl.isEmpty ||
        _tokenA.isEmpty ||
        _tokenB.isEmpty ||
        _sessionId.isEmpty ||
        _userB.isEmpty) {
      markTestSkipped(
        'transient-reconnect E2E not configured — set LIVEKIT_E2E_BASE_URL, '
        'LIVEKIT_E2E_ACCESS_TOKEN, LIVEKIT_E2E_ACCESS_TOKEN_B, '
        'LIVEKIT_E2E_SESSION_ID and LIVEKIT_E2E_USER_B (--dart-define).',
      );
      return;
    }

    // Record the real SDK lifecycle (redacted) so the diagnostic shows the
    // actual RoomReconnecting/RoomReconnected events whether it passes or fails.
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
    // Record A's state transitions so the test can assert the reconnect lifecycle
    // actually happened (reconnecting was entered, not merely connected throughout).
    final statesA = <LiveMediaState>[];
    final stateSub = clientA.states.listen(statesA.add);
    addTearDown(stateSub.cancel);
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

    // 1 & 2. Both join the SAME room; A sees B before the interruption.
    final grantA = await repoA.join(_sessionId);
    final grantB = await repoB.join(_sessionId);
    await _awaitConnected(clientA, grantA);
    await _awaitConnected(clientB, grantB);
    await _until(
      () => clientA.remoteParticipants[_userB] != null,
      reason: 'A never observed B before the interruption',
      timeout: const Duration(seconds: 30),
    );
    expect(clientA.state, isA<LiveMediaConnected>());

    // 3 & 4. The external pause freezes LiveKit (room preserved). Wait for the
    //        SDK to ACTUALLY enter reconnecting — fail loudly if it never does
    //        (that would mean no genuine interruption was observed).
    //        VERIFIED, reliable fact: the pause must make the SDK ACTUALLY enter
    //        reconnecting. Fails loudly (never fakes) if it never does.
    await _until(
      () => clientA.state is LiveMediaReconnecting,
      reason:
          'client A never entered RoomReconnecting — no genuine transient '
          'interruption was observed (the SDK did not report reconnecting)',
      timeout: const Duration(seconds: 90),
    );
    // This was a TRANSIENT reconnect of the SAME room, NOT a terminal drop: no
    // LiveMediaDisconnected may have occurred up to this point (that would be the
    // roomDeleted path, a different thing). This is what the diagnostic verifies.
    expect(
      statesA.whereType<LiveMediaDisconnected>(),
      isEmpty,
      reason: 'a terminal disconnect occurred — this was not a transient reconnect',
    );
    expect(
      statesA.any((s) => s is LiveMediaReconnecting),
      isTrue,
      reason: 'the reconnecting lifecycle was not observed',
    );

    // FULL room recovery (RoomReconnected → connected) is OBSERVED and RECORDED
    // best-effort, NOT asserted: in this headless, no-TURN harness the SIGNAL
    // reconnects but full media/ICE recovery is not guaranteed within the window.
    // This is documented as NOT VERIFIED E2E (docs/p8-live-media-verification.md,
    // Sprint 18). We never fake a recovery that did not happen.
    var fullyRecovered = false;
    final recoveryDeadline = DateTime.now().add(const Duration(seconds: 120));
    while (DateTime.now().isBefore(recoveryDeadline)) {
      final s = clientA.state;
      if (s is LiveMediaConnected) {
        fullyRecovered = true;
        break;
      }
      if (s is LiveMediaDisconnected) break; // gave up / terminal — stop waiting
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    // ignore: avoid_print
    print(
      'LKDIAG reconnect-outcome: interruptionObserved=true reconnectingEntered=true '
      'fullRoomRecovery=$fullyRecovered',
    );

    // Only if the room FULLY recovered do we additionally verify convergence on
    // the SAME room (no duplicate) and continued media — a bonus, not required.
    if (fullyRecovered) {
      await _until(
        () => clientA.remoteParticipants[_userB] != null,
        reason: 'A did not re-converge on B after a full recovery',
      );
      expect(clientA.remoteParticipants.length, 1, reason: 'A should see exactly B, once');
    }
  }, timeout: const Timeout(Duration(seconds: 300)));
}
