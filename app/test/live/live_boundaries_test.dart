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
///
/// And the non-media Live foundation that now exists (the shape asserted on
/// the source, as communities are):
///
///   live screen / state → LiveRepository → HTTP (the server) / the demo mock
///   live screen         → LiveMediaClient → Unavailable in this build
///
///   - no live screen, widget or state reaches HTTP, the socket, the API
///     client or a repository implementation — the contracts and providers
///     only;
///   - what the viewer may do is the server's answer — nothing in live reads
///     an account's permissions or roles;
///   - only the provider wiring decides which LiveRepository runs;
///   - the live wire models are plain Dart; the real repository never reads
///     the demo's data; the media client stays an abstraction with no LiveKit.
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

  /// Every file of the live feature, and the live data layer beside it.
  final live = [
    for (final path in sources.keys)
      if (path.startsWith('lib/features/live/')) path,
  ];

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
    // The live foundation's files are present, so the live-specific checks
    // below have something to check.
    for (final path in [
      'lib/data/models/live.dart',
      'lib/data/media/live_media_seams.dart',
      'lib/data/repositories/http/http_live_repository.dart',
      'lib/data/repositories/mock/mock_live_repository.dart',
      'lib/features/live/state/live_session_controller.dart',
      'lib/features/live/live_session_screen.dart',
      'lib/features/live/widgets/live_states.dart',
      'lib/features/live/live_copy.dart',
    ]) {
      expect(sources.keys, contains(path));
    }
    expect(live.length, greaterThanOrEqualTo(4));
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

  // ── The non-media Live foundation ──────────────────────────────────────────

  test('keeps live screens, widgets AND state away from every transport', () {
    final offenders = [
      for (final path in live)
        for (final uri in imports[path]!)
          if (uri.startsWith('package:http') ||
              uri.startsWith('package:web_socket') ||
              uri == 'dart:io' ||
              uri == 'dart:html' ||
              uri.endsWith('api_client.dart') ||
              uri.endsWith('websocket_realtime_client.dart') ||
              uri.contains('/repositories/http/') ||
              uri.contains('/repositories/mock/'))
            '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });

  test(
    'never lets the live feature read an account’s permissions or roles',
    () {
      final offenders = [
        for (final path in live)
          if (RegExp(r'\.permissions\b|\.roles\b|\.can\(')
              .hasMatch(sources[path]!))
            path,
      ];
      expect(offenders, isEmpty);
    },
  );

  test('lets only the provider wiring choose a live implementation', () {
    final constructing = [
      for (final MapEntry(key: path, value: text) in sources.entries)
        if (RegExp(r'\b(Http|Mock)LiveRepository\(').hasMatch(text) &&
            !path.endsWith('_live_repository.dart'))
          path,
    ];
    expect(constructing, ['lib/providers/app_providers.dart']);
  });

  test('keeps the live wire models plain Dart', () {
    // Only the provenance enum beside them, which imports nothing itself.
    expect(imports['lib/data/models/live.dart'], ['data_origin.dart']);
    expect(imports['lib/data/models/data_origin.dart'], isEmpty);
  });

  test('never lets the real live repository read the demo’s invented data', () {
    expect(
      imports['lib/data/repositories/http/http_live_repository.dart']!.where(
        (uri) => uri.contains('mock'),
      ),
      isEmpty,
    );
  });

  test(
    'keeps the live media client a pure seam — no transport, no media SDK',
    () {
      final seam = imports['lib/data/media/live_media_seams.dart']!;
      // A seam: an interface and an Unavailable default, importing nothing of
      // the kind it stands in for.
      expect(
        seam.where(
          (uri) =>
              uri.startsWith('package:http') ||
              uri.startsWith('package:web_socket') ||
              uri.endsWith('api_client.dart') ||
              media.hasMatch(uri),
        ),
        isEmpty,
      );
      // Bound once, to its Unavailable default, in the provider wiring only.
      final binding = sources['lib/providers/app_providers.dart']!;
      expect(binding.contains('UnavailableLiveMediaClient'), isTrue);
    },
  );
}
