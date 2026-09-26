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

  test('asks for nothing more than the network in release', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    expect(
      RegExp(r'<uses-permission\b').allMatches(manifest).length,
      1,
      reason: 'a new permission is a deliberate change to this test',
    );
  });
}
