import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// `flutter_secure_storage` is a native plugin (iOS Keychain, Android
/// Keystore, Web Crypto). Like `livekit_client` (ADR 0030, and
/// test/live/live_boundaries_test.dart), it is confined to ONE adapter file so
/// a native dependency can never spread across the app through a stray import.
/// Asserted on the source, so the confinement cannot erode by accident.
void main() {
  final sources = {
    for (final file
        in Directory('lib')
            .listSync(recursive: true)
            .whereType<File>()
            .where((f) => f.path.endsWith('.dart')))
      file.path.replaceAll(r'\', '/'): file.readAsStringSync(),
  };
  final imports = {
    for (final MapEntry(key: path, value: text) in sources.entries)
      path: RegExp(
        r'''^(?:import|export)\s+['"]([^'"]+)['"]''',
        multiLine: true,
      ).allMatches(text).map((m) => m.group(1)!).toList(),
  };

  const adapter = 'lib/data/api/secure_token_store.dart';
  final pkg = RegExp(r'\bflutter_secure_storage\b');

  test('reads the source tree (so the checks below are not vacuous)', () {
    expect(sources.length, greaterThan(50));
    expect(sources.keys, contains(adapter));
  });

  test('imports flutter_secure_storage only in the secure token store adapter', () {
    final offenders = [
      for (final MapEntry(key: path, value: uris) in imports.entries)
        if (path != adapter)
          for (final uri in uris)
            if (pkg.hasMatch(uri)) '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });

  test('the adapter really imports the package (the boundary is real, not vacuous)', () {
    expect(
      imports[adapter]!.where(
        (u) => u.startsWith('package:flutter_secure_storage'),
      ),
      isNotEmpty,
      reason: 'the secure token store must import the SDK it confines',
    );
  });

  test('declares flutter_secure_storage as a dependency', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(
      RegExp(
        r'^\s*flutter_secure_storage:\s*\S+',
        multiLine: true,
      ).hasMatch(pubspec),
      isTrue,
      reason: 'flutter_secure_storage must be a declared dependency',
    );
  });
}
