import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// What Android needs to show a push (ADR 0058), checked against the SERVER's
/// notification catalog — the push carries only resource names, so a type the
/// server can create without its strings here would arrive as a blank banner:
///
///   - every active type has its title and lock-screen body, with no
///     placeholder (nothing is filled in: a push names no one);
///   - release resource shrinking keeps them (res/raw/keep.xml);
///   - the app creates a channel for every active category, by the id the
///     server puts in each push, with a name;
///   - the manifest keeps Firebase from fetching a token on its own, and
///     names the status-bar icon, its tint and the fallback channel;
///   - the Firebase project's file is applied only when present, and never
///     committed.
void main() {
  final catalog = File('../backend/src/modules/notifications/domain/catalog.ts')
      .readAsStringSync();
  final strings = File(
    'android/app/src/main/res/values/notification_strings.xml',
  ).readAsStringSync();
  final mainActivity = File(
    'android/app/src/main/kotlin/com/quraninstitution/quran_institution_app/MainActivity.kt',
  ).readAsStringSync();
  final manifest = File('android/app/src/main/AndroidManifest.xml')
      .readAsStringSync();

  /// type → (category, active), read from NOTIFICATION_CATALOG's entries.
  final entries = {
    for (final match in RegExp(
      r'^\s+([A-Z_]+): \{([^}]*)\}',
      multiLine: true,
    ).allMatches(catalog.substring(catalog.indexOf('NOTIFICATION_CATALOG'))))
      match.group(1)!: (
        category: RegExp(r"category: '([A-Z_]+)'")
            .firstMatch(match.group(2)!)!
            .group(1)!,
        active: match.group(2)!.contains('active: true'),
      ),
  };
  final activeTypes = [
    for (final MapEntry(key: type, value: entry) in entries.entries)
      if (entry.active) type,
  ];
  final activeCategories = {
    for (final entry in entries.values)
      if (entry.active) entry.category,
  };

  String? stringNamed(String name) =>
      RegExp('<string name="$name">([^<]*)</string>')
          .firstMatch(strings)
          ?.group(1);

  test('reads the server catalog (so the checks below are not vacuous)', () {
    expect(
      activeTypes,
      containsAll([
        'MESSAGE_RECEIVED',
        'TASK_REMINDER',
        'LIVE_SPEAKER_GRANTED',
      ]),
    );
    expect(activeTypes.length, greaterThanOrEqualTo(20));
    expect(entries['ASSIGNMENT_CREATED']?.active, isFalse);
    expect(activeCategories, containsAll(['MESSAGES', 'TASKS']));
  });

  test(
    'ships a title and a lock-screen body for every type the server can create',
    () {
      for (final type in activeTypes) {
        final prefix = 'notification_${type.toLowerCase()}';
        for (final name in ['${prefix}_title', '${prefix}_body_private']) {
          final text = stringNamed(name);
          expect(text, isNotNull, reason: '$name is missing');
          expect(text!.trim(), isNotEmpty, reason: name);
          // Nothing is filled in: no %s, no {name}.
          expect(text, isNot(matches(RegExp(r'%|\{|\}'))), reason: name);
        }
      }
    },
  );

  test('keeps the strings through release resource shrinking', () {
    final keep = File('android/app/src/main/res/raw/keep.xml')
        .readAsStringSync();
    expect(keep, contains('tools:keep="@string/notification_*"'));
  });

  test(
    'creates a named channel for every active category, by the server’s id',
    () {
      final channels = RegExp(
        r'Triple\("([a-z]+)", R\.string\.(notification_channel_[a-z]+),',
      ).allMatches(mainActivity);
      expect(
        {for (final c in channels) c.group(1)!},
        {for (final category in activeCategories) category.toLowerCase()},
      );
      for (final channel in channels) {
        expect(
          stringNamed(channel.group(2)!),
          isNotNull,
          reason: channel.group(2),
        );
      }
    },
  );

  test('lets Firebase fetch no token on its own, and dresses a push in the app’s icon', () {
    String? metaData(String name) => RegExp(
      '<meta-data\\s+android:name="${RegExp.escape(name)}"\\s+android:(?:value|resource)="([^"]+)"',
    ).firstMatch(manifest)?.group(1);
    expect(metaData('firebase_messaging_auto_init_enabled'), 'false');
    expect(
      metaData('com.google.firebase.messaging.default_notification_icon'),
      '@drawable/ic_stat_notification',
    );
    expect(
      metaData('com.google.firebase.messaging.default_notification_color'),
      '@color/notification_accent',
    );
    expect(
      metaData('com.google.firebase.messaging.default_notification_channel_id'),
      'messages',
    );
    // A notification's small icon is white on transparent, or Android shows a square.
    final icon = File(
      'android/app/src/main/res/drawable/ic_stat_notification.xml',
    ).readAsStringSync();
    expect(
      RegExp(r'android:fillColor="([^"]+)"')
          .allMatches(icon)
          .map((m) => m.group(1))
          .toSet(),
      {'#FFFFFFFF'},
    );
  });

  test(
    'applies the Firebase project file only when present, and never commits it',
    () {
      final settings = File('android/settings.gradle.kts').readAsStringSync();
      expect(
        settings,
        contains(
          'id("com.google.gms.google-services") version "4.5.0" apply false',
        ),
      );
      final build = File('android/app/build.gradle.kts').readAsStringSync();
      expect(build, contains('if (file("google-services.json").exists())'));
      expect(
        build,
        contains('apply(plugin = "com.google.gms.google-services")'),
      );
      final ignored = File('android/.gitignore').readAsStringSync();
      expect(ignored, contains('/app/google-services.json'));
    },
  );
}
