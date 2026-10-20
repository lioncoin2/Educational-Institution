import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/publication.dart';

/// [PublicationReport] parses defensively, and its tallies are derived from the
/// server's per-community verdicts — never invented.
void main() {
  test('parses a mixed report and derives total/posted/failed', () {
    final report = PublicationReport.fromJson(const {
      'batchId': 'pub-1',
      'results': [
        {
          'communityId': 'c1',
          'status': 'posted',
          'retryable': false,
          'messageId': 'm1',
        },
        {'communityId': 'c2', 'status': 'already_posted', 'retryable': false},
        {'communityId': 'c3', 'status': 'forbidden', 'retryable': false},
        {'communityId': 'c4', 'status': 'unavailable', 'retryable': true},
      ],
    });

    expect(report.batchId, 'pub-1');
    expect(report.total, 4);
    expect(report.posted, 2); // posted + already_posted
    expect(report.failed, 2);
    expect(report.origin, DataOrigin.records);
    expect(report.retryableCommunityIds, ['c4']);
    expect(report.results.first.status, PublicationStatus.posted);
    expect(report.results.first.messageId, 'm1');
  });

  test('an unknown status is surfaced, not a crash', () {
    final report = PublicationReport.fromJson(const {
      'batchId': 'pub-2',
      'results': [
        {'communityId': 'c1', 'status': 'something_new', 'retryable': false},
      ],
    });
    expect(report.results.single.status, PublicationStatus.unknown);
    expect(report.posted, 0);
  });

  test('a malformed body yields an empty report rather than throwing', () {
    final report = PublicationReport.fromJson(const {'results': 'nope'});
    expect(report.batchId, '');
    expect(report.results, isEmpty);
  });

  test('isSuccess covers posted and already_posted only', () {
    expect(PublicationStatus.posted.isSuccess, isTrue);
    expect(PublicationStatus.alreadyPosted.isSuccess, isTrue);
    expect(PublicationStatus.forbidden.isSuccess, isFalse);
    expect(PublicationStatus.locked.isSuccess, isFalse);
  });
}
