import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/attendance/state/attendance_snapshots_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

SnapshotView _snap(String id) => SnapshotView(
  id: id,
  communityId: 'c-1',
  liveSessionId: 's-1',
  recordedBy: const SnapshotRecorder(userId: 'u-1'),
  observationRule: 'provider_registry_v1',
  observationStartedAt: DateTime.utc(2026),
  observedAt: DateTime.utc(2026),
  recordedAt: DateTime.utc(2026),
  connectedCount: 1,
  connectingCount: 0,
  origin: DataOrigin.mock,
);

SnapshotPage _page(List<String> ids, {String? next}) =>
    SnapshotPage(items: [for (final id in ids) _snap(id)], nextCursor: next);

/// Returns the scripted answers in order; records the cursors it was asked
/// with, to prove the opaque cursor is forwarded.
class _ScriptedSnapshots implements AttendanceRepository {
  _ScriptedSnapshots(this._answers);

  final List<Object> _answers; // SnapshotPage to return, or exception to throw
  int _call = 0;
  final List<String?> cursors = [];

  @override
  Future<SnapshotPage> snapshots(
    String communityId, {
    String? liveSessionId,
    String? cursor,
  }) async {
    cursors.add(cursor);
    final answer = _answers[_call++];
    if (answer is AttendanceException) throw answer;
    return answer as SnapshotPage;
  }

  @override
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  }) => throw UnimplementedError();

  @override
  Future<SnapshotView> snapshot(String snapshotId) =>
      throw UnimplementedError();

  @override
  Future<SnapshotParticipantPage> participants(
    String snapshotId, {
    SnapshotConnection? connection,
    String? cursor,
  }) => throw UnimplementedError();
}

void main() {
  final provider = attendanceSnapshotsProvider('c-1');

  ProviderContainer containerWith(AttendanceRepository repo) {
    final container = ProviderContainer(
      overrides: [
        attendanceRepositoryProvider.overrideWithValue(repo),
        sessionUserProvider.overrideWith((ref) async => null),
      ],
    );
    final sub = container.listen(provider, (_, _) {}, onError: (_, _) {});
    addTearDown(sub.close);
    addTearDown(container.dispose);
    return container;
  }

  test('loads the first page on build', () async {
    final container = containerWith(
      _ScriptedSnapshots([
        _page(['a', 'b'], next: 'c2'),
      ]),
    );
    await container.read(provider.future);
    final state = container.read(provider).value!;
    expect(state.items.map((s) => s.id), ['a', 'b']);
    expect(state.hasMore, isTrue);
  });

  test('loadMore appends the next page and dedupes by id', () async {
    final repo = _ScriptedSnapshots([
      _page(['a', 'b'], next: 'c2'),
      _page(['b', 'c']), // 'b' overlaps → deduped
    ]);
    final container = containerWith(repo);
    await container.read(provider.future);
    await container.read(provider.notifier).loadMore();
    final state = container.read(provider).value!;
    expect(state.items.map((s) => s.id), ['a', 'b', 'c']);
    expect(state.hasMore, isFalse);
    expect(repo.cursors, [null, 'c2']); // the opaque cursor was forwarded
  });

  test('loadMore failure keeps what is shown and flags a retry', () async {
    final container = containerWith(
      _ScriptedSnapshots([
        _page(['a'], next: 'c2'),
        const AttendanceException('attendance.unavailable', 'x'),
      ]),
    );
    await container.read(provider.future);
    await container.read(provider.notifier).loadMore();
    final state = container.read(provider).value!;
    expect(state.items.map((s) => s.id), ['a']);
    expect(state.loadMoreFailed, isTrue);
    expect(state.loadingMore, isFalse);
    expect(state.hasMore, isTrue);
  });

  test('refresh reloads the first page from scratch', () async {
    final container = containerWith(
      _ScriptedSnapshots([
        _page(['a'], next: 'c2'),
        _page(['z']),
      ]),
    );
    await container.read(provider.future);
    await container.read(provider.notifier).refresh();
    final state = container.read(provider).value!;
    expect(state.items.map((s) => s.id), ['z']);
  });

  test('surfaces a first-page refusal as an error', () async {
    final container = containerWith(
      _ScriptedSnapshots([
        const AttendanceException('attendance.community_not_found', 'x'),
      ]),
    );
    await expectLater(
      container.read(provider.future),
      throwsA(isA<AttendanceException>()),
    );
    expect(container.read(provider).hasError, isTrue);
  });
}
