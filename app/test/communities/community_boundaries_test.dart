import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The shape of communities in the app, asserted on the source:
///
///   screens → community state → CommunityRepository → HTTP (the server)
///                                                   → the demo's mock
///
///   - no community screen, widget or state reaches HTTP, the socket, the
///     API client or a repository implementation: only the contracts, the
///     providers, and the live connection as an abstraction;
///   - what someone may do in a community is the server's `me` — nothing
///     here reads an account's permissions or roles;
///   - only the provider wiring decides which implementation runs;
///   - the community wire models are plain Dart;
///   - the screens are right-to-left safe: no hard-coded left or right;
///   - what the screens say lives in one place (community_copy.dart).
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
  final community = [
    for (final path in sources.keys)
      if (path.startsWith('lib/features/communities/')) path,
  ];

  test('reads the source tree (so the checks below are not vacuous)', () {
    for (final path in [
      'lib/data/models/communities.dart',
      'lib/data/repositories/http/http_community_repository.dart',
      'lib/data/repositories/mock/mock_community_repository.dart',
      'lib/features/communities/community_copy.dart',
      'lib/features/communities/communities_screen.dart',
      'lib/features/communities/community_screen.dart',
      'lib/features/communities/community_members_screen.dart',
      'lib/features/communities/state/community_list_controller.dart',
      'lib/features/communities/state/community_controller.dart',
      'lib/features/communities/state/community_members_controller.dart',
      'lib/features/communities/state/community_chat_opener.dart',
    ]) {
      expect(sources.keys, contains(path));
    }
    expect(community.length, greaterThanOrEqualTo(10));
  });

  test(
    'keeps community screens, widgets and state away from every transport',
    () {
      final offenders = [
        for (final path in community)
          for (final uri in imports[path]!)
            if (uri.startsWith('package:http') ||
                uri.startsWith('package:web_socket') ||
                uri == 'dart:io' ||
                uri == 'dart:html' ||
                uri.endsWith('api_client.dart') ||
                uri.endsWith('websocket_realtime_client.dart') ||
                uri.contains('/repositories/http/') ||
                uri.contains('/repositories/mock/') ||
                uri.contains('/repositories/academic/'))
              '$path → $uri',
      ];
      expect(offenders, isEmpty);
    },
  );

  test('knows the live connection only as its abstraction and its frames', () {
    final realtime = {
      for (final path in community)
        for (final uri in imports[path]!)
          if (uri.contains('data/realtime/')) uri.split('/').last,
    };
    expect(realtime, isNotEmpty);
    expect(
      realtime,
      everyElement(anyOf('realtime_client.dart', 'realtime_frames.dart')),
    );
  });

  test('never reads an account’s permissions or roles', () {
    final offenders = [
      for (final path in community)
        if (RegExp(r'\.permissions\b|\.roles\b|\.can\(')
            .hasMatch(sources[path]!))
          path,
    ];
    expect(offenders, isEmpty);
  });

  test('lets only the provider wiring choose an implementation', () {
    final constructing = [
      for (final MapEntry(key: path, value: text) in sources.entries)
        if (RegExp(r'\b(Http|Mock)CommunityRepository\(').hasMatch(text) &&
            !path.endsWith('_community_repository.dart'))
          path,
    ];
    expect(constructing, ['lib/providers/app_providers.dart']);
  });

  test('keeps the community wire models plain Dart', () {
    // Only the provenance enum beside them, which imports nothing itself.
    expect(imports['lib/data/models/communities.dart'], ['data_origin.dart']);
    expect(imports['lib/data/models/data_origin.dart'], isEmpty);
  });

  test('never lets the real repository read the demo’s invented data', () {
    expect(
      imports['lib/data/repositories/http/http_community_repository.dart']!
          .where((uri) => uri.contains('mock')),
      isEmpty,
    );
  });

  test('reads communities and writes nothing to them', () {
    final http =
        sources['lib/data/repositories/http/http_community_repository.dart']!;
    expect(RegExp(r'_api\.(post|patch|put|delete)\(').hasMatch(http), isFalse);
    expect(RegExp(r'_api\.get\(').allMatches(http), hasLength(3));
  });

  test('lays out right to left: nothing pinned to a physical side', () {
    final physical = RegExp(
      r'EdgeInsets\.(only|fromLTRB)\([^)]*\b(left|right)\b|'
      r'EdgeInsets\.fromLTRB|'
      r'Alignment\.(centerLeft|centerRight|topLeft|topRight|bottomLeft|bottomRight)|'
      r'TextAlign\.(left|right)|'
      r'Positioned\([^)]*\b(left|right):',
    );
    final offenders = [
      for (final path in community)
        if (physical.hasMatch(sources[path]!)) path,
    ];
    expect(offenders, isEmpty);
  });

  test('says things in one place: no Arabic outside CommunityCopy', () {
    final arabicLiteral = RegExp(r'''(['"])[^'"\n]*[؀-ۿ][^'"\n]*\1''');
    final plain = [
      'lib/data/models/communities.dart',
      'lib/data/repositories/http/http_community_repository.dart',
      for (final path in community)
        if (!path.endsWith('/community_copy.dart')) path,
    ];
    for (final path in plain) {
      expect(
        arabicLiteral.allMatches(sources[path]!).map((m) => m.group(0)),
        isEmpty,
        reason: '$path should take its words from CommunityCopy',
      );
    }
    expect(
      arabicLiteral.hasMatch(
        sources['lib/features/communities/community_copy.dart']!,
      ),
      isTrue,
    );
  });
}
