import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/command_center.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/command_center/state/command_center_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// A repository that answers a fixed center, or throws — and counts reads, so
/// a refresh can be proven to re-read.
class _FakeReporting implements ReportingRepository {
  _FakeReporting(this._answer);

  final Future<CommandCenter> Function() _answer;
  int calls = 0;

  @override
  Future<CommandCenter> commandCenter() {
    calls += 1;
    return _answer();
  }
}

CommandCenter _center() => const CommandCenter(
  widgets: [
    CommandWidget(
      id: 'communities.summary',
      category: 'today',
      title: 'المجتمعات',
      metrics: [CommandMetric(key: 'total', label: 'إجمالي المجتمعات', value: 2)],
    ),
  ],
);

ProviderContainer containerWith(ReportingRepository repo) {
  final container = ProviderContainer(
    overrides: [
      reportingRepositoryProvider.overrideWithValue(repo),
      sessionUserProvider.overrideWith((ref) async => null),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  test('reads the command center from the repository', () async {
    final repo = _FakeReporting(() async => _center());
    final container = containerWith(repo);

    final center = await container.read(commandCenterProvider.future);
    expect(center.widgets.single.id, 'communities.summary');
    expect(repo.calls, 1);
  });

  test('surfaces a repository refusal as an error state (never fabricated data)', () async {
    final repo = _FakeReporting(
      () async => throw const ReportingException('identity.permission_denied', 'no'),
    );
    final container = containerWith(repo);

    await expectLater(
      container.read(commandCenterProvider.future),
      throwsA(isA<ReportingException>().having((e) => e.isForbidden, 'isForbidden', isTrue)),
    );
  });

  test('refresh re-reads the repository', () async {
    final repo = _FakeReporting(() async => _center());
    final container = containerWith(repo);
    await container.read(commandCenterProvider.future);
    expect(repo.calls, 1);

    await container.read(commandCenterProvider.notifier).refresh();
    expect(repo.calls, 2);
  });
}
