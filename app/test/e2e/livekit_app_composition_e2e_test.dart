// Real LiveKit WEB end-to-end through the PRODUCTION composition (Sprint 20).
//
// Every other E2E harness wires `LiveKitLiveMediaClient` directly, test-only.
// This one proves the thing those cannot: that the APPLICATION'S OWN provider
// wiring selects and drives the real client. Nothing here constructs a client,
// a repository or an API client — it reads them from the production providers
// under the real activation configuration (backend mode + web + the explicit
// LIVE_MEDIA_ENABLED flag), exactly as the shipped web app composes them:
//
//   liveMediaClientProvider  → LiveKitLiveMediaClient   (asserted, not built)
//   liveRepositoryProvider   → HttpLiveRepository → POST /live/sessions/:id/join
//   liveMediaProvider(id)    → LiveMediaController.connect()
//     → the real LiveKit room → LiveMediaConnected
//
// The ONLY override is `tokenStoreProvider` → an in-memory store seeded with the
// backend session token: `flutter test --platform chrome` does not run the
// generated web plugin registrant, so flutter_secure_storage's web impl is not
// installed; the credential itself is the real backend-issued one, supplied at
// run time. The media provider binding — the subject of this test — is never
// overridden.
//
// RUN (web only; needs Chrome and a reachable backend in real LiveKit mode):
//
//   flutter test test/e2e/livekit_app_composition_e2e_test.dart --platform chrome \
//     --dart-define=API_BASE_URL=http://127.0.0.1:3000 \
//     --dart-define=LIVE_MEDIA_ENABLED=true \
//     --dart-define=LIVEKIT_E2E_ACCESS_TOKEN=<backend session access token> \
//     --dart-define=LIVEKIT_E2E_SESSION_ID=<an active live session id>
//
// With the configuration incomplete the test SKIPS, so it is safe in the tree.
// The token is never logged; SDK diagnostics are redacted before printing.
@TestOn('browser')
library;

import 'dart:async';

// connectivity_plus's official web implementation entry point — the same manual
// registration the single-client harness documents: `flutter test --platform
// chrome` does not run Flutter's generated web plugin registrant, and
// livekit_client awaits Connectivity().checkConnectivity() before signalling.
// ignore: implementation_imports, depend_on_referenced_packages
import 'package:connectivity_plus/src/connectivity_plus_web.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
// Flutter SDK web plugin registry, used to invoke the web registerWith above.
// ignore: depend_on_referenced_packages
import 'package:flutter_web_plugins/flutter_web_plugins.dart';
// livekit_client's logging backend (transitive); its records are the permanent
// failure diagnostic, redacted on print.
// ignore: depend_on_referenced_packages
import 'package:logging/logging.dart';
import 'package:quran_institution_app/app/backend_config.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_live_media_client.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/features/live/state/live_media_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

const _accessToken = String.fromEnvironment('LIVEKIT_E2E_ACCESS_TOKEN');
const _sessionId = String.fromEnvironment('LIVEKIT_E2E_SESSION_ID');

/// Redacts credentials before any diagnostic line is printed: any JWT (three
/// base64url segments) and any access_token/token/secret/authorization value.
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

/// Polls [condition] until it holds or the bounded [timeout] elapses — for a
/// genuinely asynchronous server → SDK → adapter → provider update.
Future<void> _until(
  bool Function() condition, {
  required String reason,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) fail(reason);
    await Future<void>.delayed(const Duration(milliseconds: 200));
  }
}

void main() {
  // The browser E2E needs a live Flutter binding before livekit_client touches
  // Flutter state during Room.connect. The standard flutter_test initializer.
  TestWidgetsFlutterBinding.ensureInitialized();

  // Install connectivity_plus's real web implementation (not a fake) — see the
  // import note; without it the SDK hangs before signalling.
  ConnectivityPlusWebPlugin.registerWith(webPluginRegistrar);

  test('the production provider wiring joins a real LiveKit room', () async {
    if (!BackendConfig.isConfigured ||
        !BackendConfig.liveMediaEnabled ||
        _accessToken.isEmpty ||
        _sessionId.isEmpty) {
      markTestSkipped(
        'Composition E2E not configured — set API_BASE_URL, '
        'LIVE_MEDIA_ENABLED=true, LIVEKIT_E2E_ACCESS_TOKEN and '
        'LIVEKIT_E2E_SESSION_ID (--dart-define).',
      );
      return;
    }

    // Permanent, redacted failure diagnostic (buffered and re-emitted on
    // teardown so even a hang surfaces the trace).
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

    // The PRODUCTION container. backendModeProvider is true (API_BASE_URL is
    // set), liveMediaConfigEnabledProvider is true (LIVE_MEDIA_ENABLED), and
    // kIsWeb is true in the browser — so the real activation gate is satisfied
    // with NO media override. Only the token store is overridden, to inject the
    // real backend-issued credential (the web secure-storage impl is not
    // registered under `flutter test --platform chrome`).
    final tokenStore = InMemoryTokenStore();
    await tokenStore.write(
      const Tokens(accessToken: _accessToken, refreshToken: _accessToken),
    );
    final container = ProviderContainer(
      overrides: [tokenStoreProvider.overrideWithValue(tokenStore)],
    );
    addTearDown(container.dispose);

    // 1. The application composition — not the test — selected the real client.
    //    This is the whole point: a provider that compiles but is never
    //    selected is not activation.
    final boundClient = container.read(liveMediaClientProvider);
    expect(
      boundClient,
      isA<LiveKitLiveMediaClient>(),
      reason: 'the production wiring did not bind the real LiveKit client',
    );
    expect(boundClient.isAvailable, isTrue);

    // Keep the session-scoped providers alive (autoDispose) for the test.
    final media = liveMediaProvider(_sessionId);
    final settled = Completer<LiveMediaState>();
    final mediaSub = container.listen<LiveMediaState>(media, (_, next) {
      if (!settled.isCompleted &&
          (next is LiveMediaConnected ||
              next is LiveMediaFailed ||
              next is LiveMediaDisconnected)) {
        settled.complete(next);
      }
    }, fireImmediately: true);
    addTearDown(mediaSub.close);
    final publicationSub = container.listen(
      liveMediaPublicationProvider,
      (_, _) {},
    );
    addTearDown(publicationSub.close);
    final remoteSub = container.listen(liveRemoteParticipantsProvider, (_, _) {});
    addTearDown(remoteSub.close);

    LiveMediaPublication publication() =>
        container.read(liveMediaPublicationProvider).value ??
        const LiveMediaPublication();

    // 2. Joining is EXPLICIT: reading the session's media state (what opening
    //    the screen does) must not auto-connect — it is idle until commanded.
    expect(container.read(media), isA<LiveMediaIdle>());

    final controller = container.read(media.notifier);
    final repository = container.read(liveRepositoryProvider);

    // 3. Connect THROUGH the controller → the real /join → the real room.
    await controller.connect();
    final result = await settled.future.timeout(const Duration(seconds: 25));
    expect(
      result,
      isA<LiveMediaConnected>(),
      reason: 'the production path did not reach a connected LiveKit room',
    );
    // A single client here → the reconciled remote set is empty.
    expect(
      container.read(liveRemoteParticipantsProvider).value?.length ?? 0,
      0,
    );

    // 4. Microphone publish/mute reconciles from the SDK's own track events
    //    (the headless runner has a fake microphone device — a REAL publish).
    await controller.setMicrophoneEnabled(true);
    await _until(
      () => publication().microphoneOn,
      reason: 'microphone publish did not reconcile to on',
    );
    await controller.setMicrophoneEnabled(false);
    await _until(
      () => !publication().microphoneOn,
      reason: 'microphone mute did not reconcile to off',
    );

    // 5. Screen-share authority is server-authoritative and jointly gates the
    //    publish. The transition is observed through the reconciled publication,
    //    never by publishing a capture (headless Chrome has no getDisplayMedia
    //    source — real capture is the Xvfb harness's job).
    if (!publication().screenAuthorized) {
      // Not a presenter at join → the client refuses a local start (SDK
      // untouched); a grant made AFTER joining authorizes it live, no reconnect.
      await expectLater(
        controller.setScreenShareEnabled(true),
        throwsA(isA<LiveMediaException>()),
      );
      await repository.claimPresenter(_sessionId);
      await _until(
        () => publication().screenAuthorized,
        reason: 'a presenter grant did not reach the client as a live capability',
      );
    }
    // Authorized now (granted at join, or just claimed) → a revoke withdraws it
    // live through the same server → SDK → provider path.
    await repository.stopPresenter(_sessionId);
    await _until(
      () => !publication().screenAuthorized,
      reason: 'a presenter revoke did not reach the client as a live capability',
    );

    // 6. Leaving through the controller returns the session to idle and
    //    releases the room (never a remote kick/duplicate).
    await controller.disconnect();
    expect(container.read(media), isA<LiveMediaIdle>());
  }, timeout: const Timeout(Duration(seconds: 75)));
}
