import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_reporting_repository.dart';

void main() {
  test('answers a deterministic, mock-flagged command center shaped like the server', () async {
    const repo = MockReportingRepository(latency: Duration.zero);
    final center = await repo.commandCenter();

    expect(center.origin, DataOrigin.mock);
    final ids = center.widgets.map((w) => w.id).toList();
    expect(ids, containsAll(<String>['academic.structure', 'communities.summary']));

    // Every widget carries labelled metric figures (the server's shape).
    for (final widget in center.widgets) {
      expect(widget.title, isNotEmpty);
      expect(widget.metrics, isNotEmpty);
      for (final metric in widget.metrics) {
        expect(metric.label, isNotEmpty);
      }
    }
  });
}
