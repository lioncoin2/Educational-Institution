import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The layering of the live connection, asserted on the source:
///
///   screens → messaging state → RealtimeClient → WebSocket transport
///
/// Only the transport knows a socket library; the state knows the
/// abstraction and its events; screens know neither a socket nor the
/// transport.
void main() {
  final imports = <String, List<String>>{
    for (final file
        in Directory('lib')
            .listSync(recursive: true)
            .whereType<File>()
            .where((f) => f.path.endsWith('.dart')))
      file.path.replaceAll(r'\', '/'): RegExp(
        r'''^(?:import|export)\s+['"]([^'"]+)['"]''',
        multiLine: true,
      ).allMatches(file.readAsStringSync()).map((m) => m.group(1)!).toList(),
  };

  bool isSocketLibrary(String uri) =>
      uri.startsWith('package:web_socket/') ||
      uri.startsWith('package:web_socket_channel/') ||
      uri == 'dart:io' ||
      uri == 'dart:html';

  const transport = 'lib/data/realtime/websocket_realtime_client.dart';

  test('reads the source tree (so the checks below are not vacuous)', () {
    expect(imports.length, greaterThan(50));
    expect(imports[transport], contains('package:web_socket/web_socket.dart'));
  });

  test('lets only the transport import a socket library', () {
    final offenders = [
      for (final MapEntry(key: path, value: uris) in imports.entries)
        for (final uri in uris)
          if (uri.startsWith('package:web_socket') && path != transport)
            '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });

  test('keeps screens and widgets away from sockets and the transport', () {
    final offenders = [
      for (final MapEntry(key: path, value: uris) in imports.entries)
        if (path.startsWith('lib/features/'))
          for (final uri in uris)
            if (isSocketLibrary(uri) ||
                uri.endsWith('websocket_realtime_client.dart'))
              '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });

  test(
    'lets the messaging state know the connection only as an abstraction',
    () {
      final realtimeImports = [
        for (final MapEntry(key: path, value: uris) in imports.entries)
          if (path.startsWith('lib/features/'))
            for (final uri in uris)
              if (uri.contains('data/realtime/')) uri.split('/').last,
      ];
      expect(realtimeImports, isNotEmpty);
      expect(
        realtimeImports.toSet(),
        everyElement(anyOf('realtime_client.dart', 'realtime_frames.dart')),
      );
    },
  );
}
