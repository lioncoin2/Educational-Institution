import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/attendance/state/record_attendance_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// A fake attendance store that records the keys it is asked with, so the
/// controller's key lifecycle can be asserted: one key per press, the same key
/// on a retry, a fresh key after a result.
class _FakeAttendance implements AttendanceRepository {
  _FakeAttendance(this._answer);

  final Future<SnapshotView> Function(String liveSessionId, String key) _answer;
  final List<String> keys = [];

  @override
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  }) {
    keys.add(clientRequestId);
    return _answer(liveSessionId, clientRequestId);
  }
}

SnapshotView _view(String id) => SnapshotView(
  id: id,
  communityId: 'c-1',
  liveSessionId: 's-1',
  recordedBy: const SnapshotRecorder(userId: 'u-1'),
  observationRule: 'provider_registry_v1',
  observationStartedAt: DateTime.utc(2026),
  observedAt: DateTime.utc(2026),
  recordedAt: DateTime.utc(2026),
  connectedCount: 3,
  connectingCount: 0,
  origin: DataOrigin.mock,
);

void main() {
  final provider = recordAttendanceProvider('c-1');

  ProviderContainer containerWith(AttendanceRepository repo) {
    final container = ProviderContainer(
      overrides: [attendanceRepositoryProvider.overrideWithValue(repo)],
    );
    // Hold the (autoDispose) controller alive for the test, so each read sees
    // the same instance and its kept key.
    final sub = container.listen(provider, (_, _) {});
    addTearDown(sub.close);
    addTearDown(container.dispose);
    return container;
  }

  test('idle → in-flight → success carries the snapshot', () async {
    final hold = Completer<SnapshotView>();
    final container = containerWith(_FakeAttendance((_, _) => hold.future));

    expect(container.read(provider), isA<RecordIdle>());
    final future = container.read(provider.notifier).record('s-1');
    expect(container.read(provider), isA<RecordInFlight>());

    hold.complete(_view('snap-1'));
    await future;
    final state = container.read(provider);
    expect(state, isA<RecordSuccess>());
    expect((state as RecordSuccess).snapshot.id, 'snap-1');
  });

  test('a new press mints exactly one key', () async {
    final repo = _FakeAttendance((_, _) async => _view('snap-1'));
    final container = containerWith(repo);
    await container.read(provider.notifier).record('s-1');
    expect(repo.keys, hasLength(1));
    expect(repo.keys.single, isNotEmpty);
  });

  test('a failure keeps the key, and a retry reuses it', () async {
    var attempt = 0;
    final repo = _FakeAttendance((_, _) async {
      attempt++;
      if (attempt == 1) {
        throw const AttendanceException(
          'attendance.observation_unavailable',
          'no',
        );
      }
      return _view('snap-1');
    });
    final container = containerWith(repo);

    await container.read(provider.notifier).record('s-1');
    final failed = container.read(provider);
    expect(failed, isA<RecordFailure>());
    expect(
      (failed as RecordFailure).code,
      'attendance.observation_unavailable',
    );

    await container.read(provider.notifier).record('s-1'); // the retry
    expect(container.read(provider), isA<RecordSuccess>());
    expect(repo.keys, hasLength(2));
    expect(repo.keys[0], repo.keys[1]); // same key: this is the same press
  });

  test('a success clears the key; the next press mints a fresh one', () async {
    final repo = _FakeAttendance((_, _) async => _view('snap-1'));
    final container = containerWith(repo);
    final notifier = container.read(provider.notifier);

    await notifier.record('s-1');
    await notifier.record('s-1'); // a fresh press after a result
    expect(repo.keys, hasLength(2));
    expect(repo.keys[0], isNot(repo.keys[1])); // a new key
  });

  test('ignores a second press while one is in flight', () async {
    final hold = Completer<SnapshotView>();
    final repo = _FakeAttendance((_, _) => hold.future);
    final container = containerWith(repo);
    final notifier = container.read(provider.notifier);

    final first = notifier.record('s-1');
    await notifier.record('s-1'); // in flight: returns at once, no second call
    expect(repo.keys, hasLength(1));

    hold.complete(_view('snap-1'));
    await first;
    expect(container.read(provider), isA<RecordSuccess>());
  });
}
