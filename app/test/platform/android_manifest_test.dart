import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// A release build takes its permissions from the main manifest alone. The
/// debug and profile manifests declare INTERNET for the Flutter tool, which
/// hides its absence until a release build cannot reach the backend at all.
void main() {
  final internet = RegExp(
    r'<uses-permission\s+android:name="android\.permission\.INTERNET"\s*/>',
  );

  test('the release manifest lets the app reach the network', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    final permission = internet.firstMatch(manifest);
    expect(permission, isNotNull);
    // A child of <manifest>, where Android reads it — not inside <application>.
    expect(permission!.start, lessThan(manifest.indexOf('<application')));
  });

  test('asks for nothing more than the network, live audio and screen share in release', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    final declared = RegExp(
      r'<uses-permission\s+android:name="android\.permission\.([A-Z_]+)"',
    ).allMatches(manifest);
    expect(
      declared.map((m) => m.group(1)).toList(),
      [
        'INTERNET',
        // Live-session audio (LiveKit / flutter_webrtc declares none itself).
        'RECORD_AUDIO',
        'MODIFY_AUDIO_SETTINGS',
        'ACCESS_NETWORK_STATE',
        'CHANGE_NETWORK_STATE',
        'BLUETOOTH',
        'BLUETOOTH_ADMIN',
        'BLUETOOTH_CONNECT',
        // Live screen share (ADR 0051): the `mediaProjection` foreground service
        // the app owns, because neither LiveKit nor flutter_webrtc provides one.
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_MEDIA_PROJECTION',
      ],
      reason: 'a new permission is a deliberate change to this test',
    );
    // Every one is a child of <manifest>, where Android reads it.
    for (final permission in declared) {
      expect(permission.start, lessThan(manifest.indexOf('<application')));
    }
    // No camera: live media is audio + screen share only, never the camera.
    expect(manifest, isNot(contains('android.permission.CAMERA')));
  });

  test('declares the mediaProjection foreground service for screen share (ADR 0051)', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    // The service that lets Android MediaProjection run; typed so it matches the
    // FOREGROUND_SERVICE_MEDIA_PROJECTION permission, not exported (only the app
    // starts it), and declared inside <application> where services belong.
    final service = RegExp(
      r'<service\s+android:name="\.ScreenCaptureService"'
      r'\s+android:exported="false"'
      r'\s+android:foregroundServiceType="mediaProjection"\s*/>',
    ).firstMatch(manifest);
    expect(service, isNotNull, reason: 'the screen-share service must be declared');
    expect(service!.start, greaterThan(manifest.indexOf('<application')));
  });
}
