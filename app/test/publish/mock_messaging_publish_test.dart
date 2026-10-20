import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/publication.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';

/// The demo publish authorizes each community exactly as the server would — by
/// asking whether the viewer may post there — so the partial-failure UX is
/// exercised without a backend.
void main() {
  test(
    'posts where the viewer may, reports forbidden where they may not',
    () async {
      final repo = MockMessagingRepository(
        latency: Duration.zero,
        mayPostIn: (id) => id == 'c1',
      );

      final report = await repo.publishToCommunities(
        clientBatchId: 'b1',
        communityIds: ['c1', 'c2'],
        kind: 'TEXT',
        body: 'مرحبا',
      );

      expect(report.origin, DataOrigin.mock);
      expect(report.batchId, 'b1');
      final byId = {for (final r in report.results) r.communityId: r};
      expect(byId['c1']!.status, PublicationStatus.posted);
      expect(byId['c1']!.messageId, isNotNull);
      expect(byId['c2']!.status, PublicationStatus.forbidden);
      expect(report.posted, 1);
      expect(report.failed, 1);
    },
  );

  test(
    'without a mayPostIn hook, every target is posted (demo default)',
    () async {
      final repo = MockMessagingRepository(latency: Duration.zero);
      final report = await repo.publishToCommunities(
        clientBatchId: 'b2',
        communityIds: ['x', 'y', 'z'],
        kind: 'TEXT',
        body: 'hi',
      );
      expect(report.posted, 3);
      expect(report.retryableCommunityIds, isEmpty);
    },
  );
}
