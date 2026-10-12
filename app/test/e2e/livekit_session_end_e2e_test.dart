// Real SESSION-TERMINATION LiveKit end-to-end (Sprint 14).
//
// Verifies the live-session END contract end-to-end against the real pinned
// LiveKit 1.13.7: when a moderator ends the session while a client is connected,
// the backend deletes the media room, and the connected client observes the
// authoritative TERMINAL transition — not a silent hang, not an auto-rejoin to a
// room that no longer exists. It also confirms the backend refuses a fresh join
// after termination (`live.session_not_live`).
//
//   Client A = the owner/host, who is also a moderator (LIVEKIT_E2E_ACCESS_TOKEN).
//     1. join → connect to the real room.
//     2. POST /live/sessions/:id/end  (HttpLiveRepository.endSession).
//     3. the room is deleted server-side → the client's media state reconciles
//        to LiveMediaDisconnected(roomDeleted) via the real SDK event + adapter.
//     4. a subsequent join is refused with live.session_not_live.
//
// This test ENDS the session, so the workflow runs it in its OWN step, LAST,
// after every other harness has finished with the shared session. Assertions are
// at the application boundary (the media client's state and the repository's
// refusal), with bounded event-driven waits. No token is ever logged.
//
// RUN (web only; needs Chrome and a backend in real LiveKit mode):
//
//   flutter test test/e2e/livekit_session_end_e2e_test.dart --platform chrome \
//     --dart-define=LIVEKIT_E2E_BASE_URL=http://127.0.0.1:3000 \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN=<owner token> \
//     --dart-define=LIVEKIT_E2E_SESSION_ID=<active live session id>
//
// With any required define unset the test SKIPS.
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
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/http/http_live_repository.dart';

const _baseUrl = String.fromEnvironment('LIVEKIT_E2E_BASE_URL');
const _tokenA = String.fromEnvironment('LIVEKIT_E2E_ACCESS_TOKEN');
const _sessionId = String.fromEnvironment('LIVEKIT_E2E_SESSION_ID');

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  ConnectivityPlusWebPlugin.registerWith(webPluginRegistrar);

  test('ending the session disconnects a connected client and refuses new joins', () async {
    if (_baseUrl.isEmpty || _tokenA.isEmpty || _sessionId.isEmpty) {
      markTestSkipped(
        'session-end LiveKit E2E not configured — set LIVEKIT_E2E_BASE_URL, '
        'LIVEKIT_E2E_ACCESS_TOKEN and LIVEKIT_E2E_SESSION_ID (--dart-define).',
      );
      return;
    }

    Logger.root.level = Level.ALL;
    final sub = Logger.root.onRecord.listen((r) {
      // ignore: avoid_print
      print('LKDIAG ${r.level.name} ${r.loggerName}: ${_redact(r.message)}');
    });
    addTearDown(sub.cancel);

    final httpClient = http.Client();
    final store = InMemoryTokenStore();
    await store.write(const Tokens(accessToken: _tokenA, refreshToken: _tokenA));
    final repo = HttpLiveRepository(
      ApiClient(
        baseUri: Uri.parse(_baseUrl.endsWith('/') ? _baseUrl : '$_baseUrl/'),
        httpClient: httpClient,
        tokenStore: store,
      ),
    );
    final client = LiveKitLiveMediaClient();
    addTearDown(() async {
      await client.disconnect();
      await client.dispose();
      httpClient.close();
    });

    // 1. Join and connect to the real room. Register the terminal-state future
    //    BEFORE connecting so a fast connect is not missed.
    final connected = Completer<LiveMediaState>();
    final stateSub = client.states.listen((state) {
      if (!connected.isCompleted &&
          (state is LiveMediaConnected ||
              state is LiveMediaFailed ||
              state is LiveMediaDisconnected)) {
        connected.complete(state);
      }
    });
    addTearDown(stateSub.cancel);

    final grant = await repo.join(_sessionId);
    await client.connect(grant);
    expect(
      await connected.future.timeout(const Duration(seconds: 25)),
      isA<LiveMediaConnected>(),
      reason: 'the client did not reach connected',
    );

    // 2. A moderator (the owner) ends the session. The backend ends it
    //    atomically and deletes the media room (best-effort).
    final ended = await repo.endSession(_sessionId);
    expect(ended.state, LiveSessionState.ended, reason: 'the session should be ended');

    // 3. The connected client observes the authoritative TERMINAL transition:
    //    the room was deleted, so the media state reconciles to
    //    disconnected(roomDeleted) — a real SDK event through the adapter, not a
    //    fabricated state and not a silent hang.
    await _until(
      () => client.state is LiveMediaDisconnected,
      reason: 'the client did not observe a terminal disconnect after the session ended',
    );
    final terminal = client.state;
    expect(terminal, isA<LiveMediaDisconnected>());
    expect(
      (terminal as LiveMediaDisconnected).reason,
      LiveMediaDisconnectReason.roomDeleted,
      reason: 'ending the session deletes the room, so the reason must be roomDeleted',
    );

    // 4. The backend refuses a fresh join after termination — the end contract
    //    prevents new unauthorized joins (the session is no longer live).
    await expectLater(
      repo.join(_sessionId),
      throwsA(
        isA<LiveException>().having((e) => e.code, 'code', 'live.session_not_live'),
      ),
      reason: 'joining an ended session must be refused with live.session_not_live',
    );
  }, timeout: const Timeout(Duration(seconds: 90)));
}
