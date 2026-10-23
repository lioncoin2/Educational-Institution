import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The shape of academic in the app, asserted on the source:
///
///   screens → providers → CatalogRepository / LearningRepository / …
///           → AcademicRepository → HTTP (the server) or the demo's structure
///
///   - no screen or widget reaches HTTP, the API client or an HTTP repository:
///     the UI never queries the server directly;
///   - the academic wire models are plain Dart — no Flutter, no HTTP;
///   - the adapters that serve real data never read the demo's invented data
///     (MockData): a real screen cannot show a placeholder as fact;
///   - only the provider wiring decides which implementation runs;
///   - the app may manage academic STRUCTURE (sections/programs/halaqat) for a
///     holder of academic.manage (Sprint 45), and — owner-approved (Sprint 46)
///     — administer RELATIONSHIPS (enrol/assign/end) for the same holder,
///     through the repository seam; the server re-authorises every write. People
///     are found through the people directory (PeopleRepository, `people.read`,
///     OWNER/ADMIN), never the academic repository: discovery is not a mutation.
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
  const adapters = [
    'lib/data/repositories/academic/academic_catalog_repository.dart',
    'lib/data/repositories/academic/academic_learning_repository.dart',
    'lib/data/repositories/academic/academic_profile_repositories.dart',
  ];

  test('reads the source tree (so the checks below are not vacuous)', () {
    for (final path in [
      'lib/data/models/academic.dart',
      'lib/data/repositories/http/http_academic_repository.dart',
      'lib/data/repositories/mock/mock_academic_repository.dart',
      ...adapters,
    ]) {
      expect(sources.keys, contains(path));
    }
  });

  test('keeps every screen and widget away from HTTP and the API client', () {
    bool isUi(String path) =>
        path.startsWith('lib/features/') ||
        path.startsWith('lib/core/widgets/');
    final offenders = [
      for (final MapEntry(key: path, value: uris) in imports.entries)
        if (isUi(path))
          for (final uri in uris)
            if (uri.startsWith('package:http') ||
                uri.endsWith('api_client.dart') ||
                uri.contains('/repositories/http/') ||
                uri.contains('/repositories/academic/') ||
                uri.contains('/repositories/mock/'))
              '$path → $uri',
    ];
    expect(offenders, isEmpty);
  });

  test('keeps the academic wire models plain Dart', () {
    expect(imports['lib/data/models/academic.dart'], isEmpty);
  });

  test('never lets real-data adapters read the demo’s invented data', () {
    for (final path in [
      ...adapters,
      'lib/data/repositories/http/http_academic_repository.dart',
    ]) {
      expect(
        imports[path]!.where((uri) => uri.contains('mock')),
        isEmpty,
        reason: path,
      );
    }
  });

  test('lets only the provider wiring choose an implementation', () {
    final constructing = [
      for (final MapEntry(key: path, value: text) in sources.entries)
        if (RegExp(r'\b(Http|Mock)AcademicRepository\(').hasMatch(text) &&
            !path.endsWith('_academic_repository.dart'))
          path,
    ];
    expect(constructing, ['lib/providers/app_providers.dart']);
  });

  test('stays within /academic — structure and relationships, not discovery', () {
    final http =
        sources['lib/data/repositories/http/http_academic_repository.dart']!;
    // Structure management (Sprint 45) and relationship administration
    // (Sprint 46, owner-approved) are both staff tools, gated on
    // academic.manage and re-authorised server-side.
    expect(RegExp(r'_api\.(post|patch)\(').hasMatch(http), isTrue);
    // Relationships ARE now administered here (enrol / assign / end).
    expect(http.contains('/enrollments'), isTrue);
    expect(http.contains('/teachers'), isTrue);
    expect(http.contains('/teacher-assignments'), isTrue);
    // But finding people is PeopleRepository's job (people.read), never the
    // academic repository's; and it touches no other module.
    for (final foreign in const ['/people', '/communities', '/messaging']) {
      expect(http.contains(foreign), isFalse, reason: foreign);
    }
    // The reads are the four structure GETs, the two roster GETs, the two
    // admin relationship-history GETs (one student's enrolments, one teacher's
    // assignments), the two SELF-history GETs (the signed-in person's own
    // `me/enrollments` and `me/teaching`), and the program cover link GET
    // (ADR 0038).
    expect(RegExp(r'_api\.get\(').allMatches(http), hasLength(11));
  });
}
