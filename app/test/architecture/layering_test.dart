import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Project-wide dependency direction, asserted on the source.
///
/// The per-feature `test/<feature>/*_boundaries_test.dart` files already confine
/// the LiveKit, WebSocket and other SDK imports to their adapters, and check each
/// data-backed feature in detail. This test states the layer directions that hold
/// across the WHOLE app, so a new feature or data file is covered without anyone
/// adding a bespoke test:
///
///   features ──▶ data (abstractions), core, app, providers
///   data ──▶ (never features)
///   core ──▶ (never features; data only for its wire models)
///   concrete repository impls ──▶ constructed only in the composition root
///   repositories.dart (contracts) ──▶ wire models only
///
/// Each rule is asserted on the real tree (expect no offenders) AND exercised on a
/// synthetic input (expect it flags one), so none can pass vacuously.
///
/// Only rules the code already satisfies are asserted here. A blanket
/// "feature must not import another feature" is deliberately NOT asserted: the app
/// has real, intended cross-feature UI edges (a shared sign-in prompt, a connection
/// banner, the attendance → live/communities state the attendance design approves).
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

  /// A lib-relative import URI resolved to a lib-relative target, or null if the
  /// import leaves the app (a `package:` other than our own, or `dart:`).
  String? resolveLibTarget(String fromLibPath, String uri) {
    const self = 'package:quran_institution_app/';
    if (uri.startsWith(self)) return 'lib/${uri.substring(self.length)}';
    if (uri.startsWith('package:') || uri.startsWith('dart:')) return null;
    final segments = fromLibPath.split('/')..removeLast();
    for (final part in uri.split('/')) {
      if (part == '' || part == '.') continue;
      if (part == '..') {
        if (segments.isNotEmpty) segments.removeLast();
      } else {
        segments.add(part);
      }
    }
    final resolved = segments.join('/');
    return resolved.startsWith('lib/') ? resolved : null;
  }

  bool isConcreteRepoImpl(String target) =>
      target.contains('/data/repositories/http/') ||
      target.contains('/data/repositories/mock/');

  // Each direction rule as a predicate on (importer, resolvedTarget), so the
  // negative-control test can drive it with synthetic values.
  bool dataReachesFeatures(String from, String target) =>
      from.startsWith('lib/data/') && target.startsWith('lib/features/');

  bool coreReachesFeatures(String from, String target) =>
      from.startsWith('lib/core/') && target.startsWith('lib/features/');

  bool coreReachesNonModelData(String from, String target) =>
      from.startsWith('lib/core/') &&
      target.startsWith('lib/data/') &&
      !target.startsWith('lib/data/models/');

  bool uiReachesConcreteImpl(String from, String target) =>
      (from.startsWith('lib/features/') || from.startsWith('lib/core/')) &&
      isConcreteRepoImpl(target);

  bool contractsReachBeyondModels(String from, String target) =>
      from == 'lib/data/repositories/repositories.dart' &&
      target.startsWith('lib/data/') &&
      !target.startsWith('lib/data/models/');

  List<String> offenders(bool Function(String from, String target) violates) => [
    for (final MapEntry(key: from, value: uris) in imports.entries)
      for (final uri in uris)
        if (resolveLibTarget(from, uri) case final String target)
          if (violates(from, target)) '$from → $uri',
  ];

  test('reads the source tree (so the checks below are not vacuous)', () {
    expect(imports.length, greaterThan(50));
    // The composition root really does reach the concrete impls these rules keep
    // out of the rest of the app — so the rules are about edges that exist.
    final providerImpls = imports['lib/providers/app_providers.dart'] ?? const [];
    expect(
      providerImpls.any((uri) => uri.contains('/repositories/')),
      isTrue,
      reason: 'app_providers.dart is expected to wire the repositories',
    );
  });

  test('the data layer never imports a feature', () {
    expect(offenders(dataReachesFeatures), isEmpty);
  });

  test('core never imports a feature, and reaches data only for wire models', () {
    expect(offenders(coreReachesFeatures), isEmpty);
    expect(offenders(coreReachesNonModelData), isEmpty);
  });

  test('concrete repository impls are reached only from the composition root', () {
    // Features and core depend on the abstract repositories (overview.md §7);
    // the Http*/Mock* classes are constructed in lib/providers/app_providers.dart.
    expect(offenders(uiReachesConcreteImpl), isEmpty);
  });

  test('the repository contracts stay pure (wire models only)', () {
    expect(offenders(contractsReachBeyondModels), isEmpty);
  });

  test('every direction rule can fire (negative control)', () {
    expect(resolveLibTarget('lib/data/x.dart', '../features/y.dart'), 'lib/features/y.dart');
    expect(dataReachesFeatures('lib/data/x.dart', 'lib/features/y.dart'), isTrue);
    expect(coreReachesFeatures('lib/core/x.dart', 'lib/features/y.dart'), isTrue);
    expect(coreReachesNonModelData('lib/core/x.dart', 'lib/data/repositories/http/y.dart'), isTrue);
    expect(coreReachesNonModelData('lib/core/x.dart', 'lib/data/models/y.dart'), isFalse);
    expect(
      uiReachesConcreteImpl('lib/features/a/x.dart', 'lib/data/repositories/mock/y.dart'),
      isTrue,
    );
    expect(
      contractsReachBeyondModels('lib/data/repositories/repositories.dart', 'lib/data/api/y.dart'),
      isTrue,
    );
  });
}
