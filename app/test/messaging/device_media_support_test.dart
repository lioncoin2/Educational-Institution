import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/device_media_support_stub.dart'
    as native;
import 'package:quran_institution_app/data/media/device_media_support_web.dart'
    as web;
import 'package:quran_institution_app/providers/app_providers.dart';

/// Where the device-media plugins are bound (ADR 0059): the web and Android,
/// decided on the REAL operating system — never `defaultTargetPlatform`, which
/// `flutter test` reports as Android.
void main() {
  group('native', () {
    test('Android runs the media plugins', () {
      expect(native.deviceMediaSupported(operatingSystem: 'android'), isTrue);
    });

    test('iOS and the desktops do not (yet)', () {
      for (final os in ['ios', 'macos', 'linux', 'windows', 'fuchsia']) {
        expect(
          native.deviceMediaSupported(operatingSystem: os),
          isFalse,
          reason: os,
        );
      }
    });

    test('a VM test host reads false — whatever the target platform says', () {
      // The fact every widget test relies on: the composer, the voice bubble
      // and the pickers keep the Unavailable defaults on the VM, although
      // `defaultTargetPlatform` is Android under `flutter test`.
      expect(defaultTargetPlatform, TargetPlatform.android);
      expect(native.deviceMediaSupported(), isFalse);
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(container.read(deviceMediaSupportedProvider), isFalse);
    });
  });

  test('the web always runs them', () {
    expect(web.deviceMediaSupported(), isTrue);
    expect(web.deviceMediaSupported(operatingSystem: 'ios'), isTrue);
  });
}
