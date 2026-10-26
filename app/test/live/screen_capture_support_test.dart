import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/screen_capture_support.dart';

/// The native screen-capture CAPABILITY (ADR 0051): which platforms can publish
/// the screen, decided without the SDK so the UI gate can read it. On the Dart
/// VM this exercises the native (stub) implementation; the web feature-probe is
/// the web build's concern (and is covered by the panel test's parametrization).
void main() {
  group('screenCaptureSupported (native capability)', () {
    test('off without the native screen-share opt-in, on every platform', () {
      for (final platform in TargetPlatform.values) {
        expect(
          screenCaptureSupported(
            platform: platform,
            nativeScreenShareEnabled: false,
          ),
          isFalse,
          reason: '$platform must be unsupported without the opt-in',
        );
      }
    });

    test('Android and iOS are supported with the opt-in', () {
      for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
        expect(
          screenCaptureSupported(
            platform: platform,
            nativeScreenShareEnabled: true,
          ),
          isTrue,
          reason: '$platform must support capture with the opt-in',
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
          screenCaptureSupported(
            platform: platform,
            nativeScreenShareEnabled: true,
          ),
          isFalse,
          reason: '$platform has no screen-capture path',
        );
      }
    });
  });
}
