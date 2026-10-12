import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The message-attachment device plugins (Sprint 21) stay confined to one
/// adapter file each — exactly as `livekit_client` (ADR 0030) and
/// `flutter_secure_storage` (Sprint 19) are. A plugin that leaks into a screen,
/// a controller, a repository or the models would couple the app to a native
/// dependency it cannot build or verify here; the seam
/// (`lib/data/media/media_seams.dart`) is the only thing those layers touch.
void main() {
  final sources = {
    for (final file in Directory('lib')
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

  // plugin package → the one adapter file allowed to import it.
  const confinement = {
    'file_picker': 'lib/data/media/pickers/file_picker_attachment_picker.dart',
    'record': 'lib/data/media/voice/record_voice_recorder.dart',
    'just_audio': 'lib/data/media/voice/just_audio_voice_player.dart',
  };

  test('reads the source tree (so the checks below are not vacuous)', () {
    expect(sources.length, greaterThan(50));
    for (final adapter in confinement.values) {
      expect(sources.keys, contains(adapter), reason: '$adapter must exist');
    }
  });

  confinement.forEach((package, adapter) {
    final matcher = RegExp('\\bpackage:$package/');

    test('imports package:$package only in its adapter', () {
      final offenders = [
        for (final MapEntry(key: path, value: uris) in imports.entries)
          if (path != adapter)
            for (final uri in uris)
              if (matcher.hasMatch(uri)) '$path → $uri',
      ];
      expect(offenders, isEmpty);
    });

    test('the $package adapter really imports it (non-vacuous)', () {
      expect(
        imports[adapter]!.where(matcher.hasMatch),
        isNotEmpty,
        reason: '$adapter must import package:$package — the boundary is real',
      );
    });
  });

  test('every attachment plugin is a declared dependency', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    for (final package in confinement.keys) {
      expect(
        RegExp('^\\s*$package:\\s', multiLine: true).hasMatch(pubspec),
        isTrue,
        reason: '$package must be declared in pubspec.yaml',
      );
    }
  });
}
