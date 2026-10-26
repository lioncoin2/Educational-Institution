import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/live_media_platform.dart';
import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_live_media_client.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The Sprint 20 production binding policy for [liveMediaClientProvider]: the
/// real LiveKit client is selected ONLY when a backend is configured, the build
/// explicitly enables live media, AND the platform is the supported web target.
/// Every other combination — the demo build, a disabled/absent flag, an
/// unsupported platform — falls closed to [UnavailableLiveMediaClient].
///
/// Policy only, deterministic, no SDK and no network: constructing a
/// [LiveKitLiveMediaClient] touches no platform channel until `connect`, so the
/// selection is asserted on the VM. The real connect / microphone / screen /
/// disconnect path through this very binding is covered against a real LiveKit
/// server by the browser composition E2E
/// (`test/e2e/livekit_app_composition_e2e_test.dart`).
ProviderContainer _container({
  required bool backend,
  required bool enabled,
  required bool web,
}) => ProviderContainer(
  overrides: [
    backendModeProvider.overrideWithValue(backend),
    liveMediaConfigEnabledProvider.overrideWithValue(enabled),
    liveMediaPlatformSupportedProvider.overrideWithValue(web),
  ],
);

void main() {
  group('liveMediaClientProvider selection', () {
    test('backend + enabled + web → the real LiveKit client', () {
      final container = _container(backend: true, enabled: true, web: true);
      addTearDown(container.dispose);
      final client = container.read(liveMediaClientProvider);
      expect(client, isA<LiveKitLiveMediaClient>());
      expect(client.isAvailable, isTrue);
    });

    test('backend + enabled + NOT web → unavailable (web-first only)', () {
      final container = _container(backend: true, enabled: true, web: false);
      addTearDown(container.dispose);
      expect(
        container.read(liveMediaClientProvider),
        isA<UnavailableLiveMediaClient>(),
      );
    });

    test('backend + flag off + web → unavailable (fail closed)', () {
      final container = _container(backend: true, enabled: false, web: true);
      addTearDown(container.dispose);
      expect(
        container.read(liveMediaClientProvider),
        isA<UnavailableLiveMediaClient>(),
      );
    });

    test('demo mode + enabled + web → unavailable (never in the demo)', () {
      final container = _container(backend: false, enabled: true, web: true);
      addTearDown(container.dispose);
      expect(
        container.read(liveMediaClientProvider),
        isA<UnavailableLiveMediaClient>(),
      );
    });

    test('a plain container (widget-test defaults) → unavailable', () {
      // No backend configured, flag off, kIsWeb false under the VM: every gate
      // fails, so an ordinary widget test never builds a real client.
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(
        container.read(liveMediaClientProvider),
        isA<UnavailableLiveMediaClient>(),
      );
    });

    test('binds exactly one client (one room owner)', () {
      final container = _container(backend: true, enabled: true, web: true);
      addTearDown(container.dispose);
      final first = container.read(liveMediaClientProvider);
      final second = container.read(liveMediaClientProvider);
      expect(identical(first, second), isTrue);
    });

    test('disposing the provider disposes the real client', () async {
      final container = _container(backend: true, enabled: true, web: true);
      final client =
          container.read(liveMediaClientProvider) as LiveKitLiveMediaClient;
      container.dispose();
      // dispose() closes the state stream; `isEmpty` on a closed broadcast
      // stream completes true rather than hanging. Had the provider NOT disposed
      // the client, the stream would stay open and this would time out — so a
      // leaked SDK room / listener would fail the test, not pass it silently.
      final closed = await client.states.isEmpty.timeout(
        const Duration(seconds: 2),
        onTimeout: () => false,
      );
      expect(closed, isTrue, reason: 'the client was not disposed with the provider');
    });
  });

  // Which platforms run the real client: the web as before; iOS/Android only
  // with the native opt-in (LIVE_MEDIA_NATIVE_ENABLED); never anything else.
  group('liveMediaPlatformSupported', () {
    test('the web is supported whatever the native opt-in says', () {
      for (final nativeEnabled in [false, true]) {
        for (final platform in TargetPlatform.values) {
          expect(
            liveMediaPlatformSupported(
              isWeb: true,
              platform: platform,
              nativeEnabled: nativeEnabled,
            ),
            isTrue,
          );
        }
      }
    });

    test('iOS and Android are supported only with the native opt-in', () {
      for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
        expect(
          liveMediaPlatformSupported(
            isWeb: false,
            platform: platform,
            nativeEnabled: false,
          ),
          isFalse,
        );
        expect(
          liveMediaPlatformSupported(
            isWeb: false,
            platform: platform,
            nativeEnabled: true,
          ),
          isTrue,
        );
      }
    });

    test('desktop targets stay unsupported even with the opt-in', () {
      for (final platform in [
        TargetPlatform.linux,
        TargetPlatform.macOS,
        TargetPlatform.windows,
        TargetPlatform.fuchsia,
      ]) {
        expect(
          liveMediaPlatformSupported(
            isWeb: false,
            platform: platform,
            nativeEnabled: true,
          ),
          isFalse,
        );
      }
    });

    test('this build (VM, no opt-in) is unsupported and mutes nothing', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(container.read(liveMediaPlatformSupportedProvider), isFalse);
      expect(container.read(liveMediaMuteInBackgroundProvider), isFalse);
    });

    test('a supported native platform turns the mic off in the background', () {
      final container = ProviderContainer(
        overrides: [liveMediaPlatformSupportedProvider.overrideWithValue(true)],
      );
      addTearDown(container.dispose);
      // kIsWeb is false on the VM, so this is the native case.
      expect(container.read(liveMediaMuteInBackgroundProvider), isTrue);
    });
  });

  // ADR 0051 — native screen SHARE is a SEPARATE capability from native audio,
  // behind its own opt-in (LIVE_MEDIA_NATIVE_SCREEN_SHARE_ENABLED). This build
  // (the VM, no define) therefore does not support screen capture, so the
  // "share screen" control stays disabled with an accurate message.
  group('screen-capture support provider', () {
    test('this build (VM, no screen-share opt-in) does not support capture', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(container.read(screenCaptureSupportedProvider), isFalse);
    });
  });
}
