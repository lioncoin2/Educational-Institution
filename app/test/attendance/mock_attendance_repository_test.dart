import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_attendance_repository.dart';

/// The demo attendance store: invented, flagged [DataOrigin.mock], and
/// reproducing the server's idempotency rule — a key already seen returns the
/// same snapshot, a new key a new one.
void main() {
  MockAttendanceRepository repo() =>
      MockAttendanceRepository(latency: Duration.zero);

  test('records an invented, mock-flagged snapshot', () async {
    final view = await repo().record('s-1', clientRequestId: 'key-abcdefgh');
    expect(view.liveSessionId, 's-1');
    expect(view.origin, DataOrigin.mock);
    expect(view.connectedCount, greaterThanOrEqualTo(0));
    expect(view.connectingCount, greaterThanOrEqualTo(0));
  });

  test(
    'reproduces idempotency: the same key returns the same snapshot',
    () async {
      final store = repo();
      final first = await store.record('s-1', clientRequestId: 'key-abcdefgh');
      final again = await store.record('s-1', clientRequestId: 'key-abcdefgh');
      expect(identical(first, again), isTrue);
      expect(again.id, first.id);
    },
  );

  test('a different key is a different snapshot', () async {
    final store = repo();
    final first = await store.record('s-1', clientRequestId: 'key-abcdefgh');
    final other = await store.record('s-1', clientRequestId: 'key-12345678');
    expect(other.id, isNot(first.id));
  });
}
