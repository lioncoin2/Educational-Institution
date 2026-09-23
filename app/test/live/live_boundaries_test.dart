import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Live media in the app, before any of it exists — asserted on the source so
/// it cannot arrive by accident:
///
///   - no LiveKit or WebRTC package is a dependency. `livekit_client` pulls in
///     the native `flutter_webrtc`, and a native dependency is never added
///     blind: it cannot be built or verified on a device from here
///     (`lib/data/media/media_seams.dart`). When live audio lands, it lands as
///     a seam — an interface with an Unavailable default, bound in one
///     provider — through its own reviewed change;
///   - no Dart file imports one either, so a stray import cannot sneak the
///     package in through a transitive dependency;
///   - no screen or widget reaches a transport — HTTP, the API client, the
///     WebSocket library or the realtime transport — whatever feature it
///     belongs to: screens depend on repositories and controllers only.
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
  final media = RegExp(
    r'\b(livekit_client|livekit_components|flutter_webrtc|dart_webrtc)\b',
  );

  test('reads the source tree (so the checks below are not vacuous)', () {
    expect(sources.length, greaterThan(50));
    // The transport the UI must not reach is really there to be reached.
    expect(
      sources.keys,
      contains('lib/data/realtime/websocket_realtime_client.dart'),
    );
    expect(
      sources.keys.where((path) => path.startsWith('lib/features/')),
      isNotEmpty,
    );
  });

  test('declares no LiveKit or WebRTC dependency', () {
    for (final file in ['pubspec.yaml', 'pubspec.lock']) {
      final text = File(file).readAsStringSync();
      expect(media.hasMatch(text), isFalse, reason: file);
    }
  });

  test('imports no LiveKit or WebRTC package anywhere under lib/', () {
    final offenders = [
      for (final MapEntry(key: path, value: uris) in imports.entries)
        for (final uri in uris)
          if (media.hasMatch(uri)) '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });

  test('keeps every screen and widget away from every transport', () {
    bool isUi(String path) =>
        path.startsWith('lib/features/') && !path.contains('/state/') ||
        path.startsWith('lib/core/widgets/');
    final offenders = [
      for (final MapEntry(key: path, value: uris) in imports.entries)
        if (isUi(path))
          for (final uri in uris)
            if (uri.startsWith('package:http') ||
                uri.startsWith('package:web_socket') ||
                uri.endsWith('api_client.dart') ||
                uri.endsWith('websocket_realtime_client.dart') ||
                uri.contains('/repositories/http/') ||
                uri.contains('/repositories/mock/') ||
                media.hasMatch(uri))
              '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });
}
