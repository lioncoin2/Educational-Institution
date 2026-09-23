import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The shape of notifications in the app, asserted on the source:
///
///   screens → notification state → NotificationsRepository → ApiClient
///
///   - no push SDK (Firebase, APNs, OneSignal, local notifications) is a
///     dependency or imported anywhere: push is a seam (push_seams.dart);
///   - the notification screens and widgets know neither HTTP nor the
///     socket, only state and repositories' contracts;
///   - what notifications say lives in one place (notification_copy.dart),
///     not in the state or the repository.
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

  const pushPackages = [
    'firebase_messaging',
    'firebase_core',
    'flutter_local_notifications',
    'onesignal_flutter',
    'flutter_apns',
    'flutter_apns_only',
    'push',
    'awesome_notifications',
  ];

  test('reads the source tree (so the checks below are not vacuous)', () {
    expect(
      sources.keys,
      contains('lib/features/notifications/notifications_screen.dart'),
    );
    expect(sources.keys, contains('lib/data/push/push_seams.dart'));
  });

  test('depends on no push SDK — push is a seam until one can be verified', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    for (final package in pushPackages) {
      expect(
        pubspec,
        isNot(matches(RegExp('^\\s+$package:', multiLine: true))),
      );
    }
    final offenders = [
      for (final MapEntry(key: path, value: uris) in imports.entries)
        for (final uri in uris)
          if (pushPackages.any((p) => uri.startsWith('package:$p/')))
            '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });

  test(
    'keeps notification screens and widgets away from HTTP and the socket',
    () {
      bool isUi(String path) =>
          (path.startsWith('lib/features/notifications/') &&
              !path.startsWith('lib/features/notifications/state/')) ||
          path == 'lib/core/widgets/patterns/notification_tile.dart' ||
          path == 'lib/core/widgets/foundations/unread_badge.dart';
      final offenders = [
        for (final MapEntry(key: path, value: uris) in imports.entries)
          if (isUi(path))
            for (final uri in uris)
              if (uri.startsWith('package:http') ||
                  uri.startsWith('package:web_socket') ||
                  uri.endsWith('api_client.dart') ||
                  uri.contains('/repositories/http/') ||
                  uri.endsWith('websocket_realtime_client.dart'))
                '$path → $uri',
      ];
      expect(offenders, isEmpty);
    },
  );

  test('says things in one place: no Arabic sentences in state, models or repositories', () {
    final arabicLiteral = RegExp(
      r'''(['"])[^'"\n]*[\u0600-\u06FF][^'"\n]*\1''',
    );
    const plain = [
      'lib/data/models/notifications.dart',
      'lib/data/repositories/http/http_notifications_repository.dart',
      'lib/features/notifications/notification_target_resolver.dart',
      'lib/features/notifications/notifications_screen.dart',
      'lib/features/notifications/notification_settings_screen.dart',
      'lib/features/notifications/state/notification_list_controller.dart',
      'lib/features/notifications/state/notification_preferences_controller.dart',
      'lib/features/notifications/state/push_registration.dart',
      'lib/features/notifications/state/unread_count_controller.dart',
    ];
    for (final path in plain) {
      expect(sources[path], isNotNull, reason: path);
      expect(
        arabicLiteral
            .allMatches(sources[path]!)
            .map((m) => m.group(0))
            .toList(),
        isEmpty,
        reason: '$path should take its words from NotificationCopy',
      );
    }
    // …and the copy really is where the words are.
    expect(
      arabicLiteral.hasMatch(
        sources['lib/features/notifications/notification_copy.dart']!,
      ),
      isTrue,
    );
  });
}
