import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_attendance_repository.dart';

/// The demo view store: invented, flagged mock, stable across calls, and
/// paginated with an opaque cursor — honoring the connection filter the UI
/// does not yet expose.
void main() {
  MockAttendanceRepository repo() =>
      MockAttendanceRepository(latency: Duration.zero);

  Future<List<SnapshotView>> allSnapshots(
    MockAttendanceRepository store,
    String communityId,
  ) async {
    final items = <SnapshotView>[];
    String? cursor;
    do {
      final page = await store.snapshots(communityId, cursor: cursor);
      items.addAll(page.items);
      cursor = page.nextCursor;
    } while (cursor != null);
    return items;
  }

  test(
    'snapshots paginate with an opaque cursor and are mock-flagged',
    () async {
      final store = repo();
      final first = await store.snapshots('c-1');
      expect(first.items, isNotEmpty);
      expect(first.items.first.origin, DataOrigin.mock);
      expect(first.nextCursor, isNotNull); // more than one page

      final all = await allSnapshots(store, 'c-1');
      final ids = all.map((s) => s.id).toList();
      expect(ids.toSet(), hasLength(ids.length)); // no duplicates across pages
      expect(all.length, greaterThan(first.items.length));
    },
  );

  test('a repeated first page is identical (stable across calls)', () async {
    final store = repo();
    final a = await store.snapshots('c-1');
    final b = await store.snapshots('c-1');
    expect(a.items.map((s) => s.id), b.items.map((s) => s.id));
    expect(a.nextCursor, b.nextCursor);
  });

  test(
    'snapshot(id) returns the same object identity for the same id',
    () async {
      final store = repo();
      final first = (await store.snapshots('c-1')).items.first;
      final byId = await store.snapshot(first.id);
      expect(identical(byId, first), isTrue);
      // A direct, unseen id is synthesized once and then stable.
      final x1 = await store.snapshot('unseen-x');
      final x2 = await store.snapshot('unseen-x');
      expect(identical(x1, x2), isTrue);
    },
  );

  test('participants paginate and are keyed ascending by account id', () async {
    final store = repo();
    final snapshot = (await store.snapshots('c-1')).items.first;
    final page = await store.participants(snapshot.id);
    expect(page.items, isNotEmpty);
    expect(page.items.first.origin, DataOrigin.mock);
    final ids = page.items.map((p) => p.userId).toList();
    final sorted = [...ids]..sort();
    expect(ids, sorted);
  });

  test('participants honor the connection filter', () async {
    final store = repo();
    final snapshot = (await store.snapshots('c-1')).items.first;
    final connected = await store.participants(
      snapshot.id,
      connection: SnapshotConnection.connected,
    );
    expect(
      connected.items.every(
        (p) => p.connection == SnapshotConnection.connected,
      ),
      isTrue,
    );
    final connecting = await store.participants(
      snapshot.id,
      connection: SnapshotConnection.connecting,
    );
    expect(
      connecting.items.every(
        (p) => p.connection == SnapshotConnection.connecting,
      ),
      isTrue,
    );
  });
}
