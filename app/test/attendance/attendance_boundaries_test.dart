import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The attendance record foundation, asserted on the source so a forbidden edge
/// cannot arrive by accident (attendance.md §17; the shape the Live and
/// Communities boundary tests pin for their own features):
///
///   record screen / state → AttendanceRepository → the API client / the mock
///   record screen          → liveSessionProvider  → the Live abstraction
///   record screen          → communityProvider    → the community's `me`
///
///   - no attendance screen, widget or state reaches a transport — HTTP, the
///     API client, the WebSocket library or a repository implementation — only
///     contracts, controllers and the Live/community providers it consumes;
///   - attendance imports no Academic, and no live-session SCREEN (it depends
///     on the Live abstraction, never its UI — the approved direction);
///   - no media: no LiveKit or WebRTC dependency or import, anywhere;
///   - what the viewer may do is the server's answer — nothing in attendance
///     reads an account's permissions or roles;
///   - only the provider wiring decides which AttendanceRepository runs;
///   - the attendance wire model is plain Dart; the real repository never reads
///     the demo's invented data.
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

  /// Every file of the attendance feature.
  final feature = [
    for (final path in sources.keys)
      if (path.startsWith('lib/features/attendance/')) path,
  ];

  /// The feature plus the attendance data layer beside it — the whole slice,
  /// for the rules that hold across all of it (no Academic, no live screen).
  final slice = [
    ...feature,
    'lib/data/models/attendance.dart',
    'lib/data/repositories/http/http_attendance_repository.dart',
    'lib/data/repositories/mock/mock_attendance_repository.dart',
  ];

  test('reads the source tree (so the checks below are not vacuous)', () {
    expect(sources.length, greaterThan(50));
    // The transport and the live SCREEN the feature must not reach really
    // exist, so forbidding them means something.
    expect(sources.keys, contains('lib/data/api/api_client.dart'));
    expect(
      sources.keys,
      contains('lib/features/live/live_session_screen.dart'),
    );
    // The attendance slice's files are present.
    for (final path in [
      'lib/data/models/attendance.dart',
      'lib/data/repositories/http/http_attendance_repository.dart',
      'lib/data/repositories/mock/mock_attendance_repository.dart',
      'lib/features/attendance/state/record_attendance_controller.dart',
      'lib/features/attendance/record_attendance_screen.dart',
      'lib/features/attendance/widgets/attendance_states.dart',
      'lib/features/attendance/attendance_copy.dart',
    ]) {
      expect(sources.keys, contains(path));
    }
    expect(feature.length, greaterThanOrEqualTo(4));
  });

  test(
    'declares no LiveKit or WebRTC dependency, and imports none under lib/',
    () {
      for (final file in ['pubspec.yaml', 'pubspec.lock']) {
        expect(
          media.hasMatch(File(file).readAsStringSync()),
          isFalse,
          reason: file,
        );
      }
      final offenders = [
        for (final MapEntry(key: path, value: uris) in imports.entries)
          for (final uri in uris)
            if (media.hasMatch(uri)) '$path → $uri',
      ];
      expect(offenders, isEmpty);
    },
  );

  test('keeps the attendance feature away from every transport', () {
    final offenders = [
      for (final path in feature)
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

  test('never lets attendance import Academic, or the live-session screen', () {
    final offenders = [
      for (final path in slice)
        for (final uri in imports[path]!)
          if (uri.contains('academic') ||
              uri.endsWith('live_session_screen.dart'))
            '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });

  test(
    'never lets the attendance feature read an account’s permissions or roles',
    () {
      final offenders = [
        for (final path in feature)
          if (RegExp(r'\.permissions\b|\.roles\b|\.can\(')
              .hasMatch(sources[path]!))
            path,
      ];
      expect(offenders, isEmpty);
    },
  );

  test('lets only the provider wiring choose an attendance implementation', () {
    final constructing = [
      for (final MapEntry(key: path, value: text) in sources.entries)
        if (RegExp(r'\b(Http|Mock)AttendanceRepository\(').hasMatch(text) &&
            !path.endsWith('_attendance_repository.dart'))
          path,
    ];
    expect(constructing, ['lib/providers/app_providers.dart']);
  });

  test('keeps the attendance wire model plain Dart', () {
    // Only the provenance enum beside it, which imports nothing itself.
    expect(imports['lib/data/models/attendance.dart'], ['data_origin.dart']);
  });

  test(
    'never lets the real attendance repository read the demo’s invented data',
    () {
      expect(
        imports['lib/data/repositories/http/http_attendance_repository.dart']!
            .where((uri) => uri.contains('mock')),
        isEmpty,
      );
    },
  );
}
