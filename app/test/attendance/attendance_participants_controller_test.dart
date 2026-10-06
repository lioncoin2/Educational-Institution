import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/attendance/state/attendance_snapshot_detail_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

SnapshotParticipant _p(String id) => SnapshotParticipant(
  userId: id,
  displayName: 'مشارك $id',
  connection: SnapshotConnection.connected,
  origin: DataOrigin.mock,
);

SnapshotParticipantPage _page(List<String> ids, {String? next}) =>
    SnapshotParticipantPage(
      items: [for (final id in ids) _p(id)],
      nextCursor: next,
    );

class _ScriptedParticipants implements AttendanceRepository {
  _ScriptedParticipants(this._answers);

  final List<Object> _answers;
  int _call = 0;
  final List<String?> cursors = [];

  @override
  Future<SnapshotParticipantPage> participants(
    String snapshotId, {
    SnapshotConnection? connection,
    String? cursor,
  }) async {
    cursors.add(cursor);
    final answer = _answers[_call++];
    if (answer is AttendanceException) throw answer;
    return answer as SnapshotParticipantPage;
  }

  @override
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  }) => throw UnimplementedError();

  @override
  Future<SnapshotPage> snapshots(
    String communityId, {
    String? liveSessionId,
    String? cursor,
  }) => throw UnimplementedError();

  @override
  Future<SnapshotView> snapshot(String snapshotId) =>
      throw UnimplementedError();
}

void main() {
  final provider = attendanceParticipantsProvider('s-1');

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
      _ScriptedParticipants([
        _page(['u-1', 'u-2'], next: 'p2'),
      ]),
    );
    await container.read(provider.future);
    final state = container.read(provider).value!;
    expect(state.items.map((p) => p.userId), ['u-1', 'u-2']);
    expect(state.hasMore, isTrue);
  });

  test('loadMore appends and dedupes by account id', () async {
    final repo = _ScriptedParticipants([
      _page(['u-1', 'u-2'], next: 'p2'),
      _page(['u-2', 'u-3']), // 'u-2' overlaps → deduped
    ]);
    final container = containerWith(repo);
    await container.read(provider.future);
    await container.read(provider.notifier).loadMore();
    final state = container.read(provider).value!;
    expect(state.items.map((p) => p.userId), ['u-1', 'u-2', 'u-3']);
    expect(state.hasMore, isFalse);
    expect(repo.cursors, [null, 'p2']);
  });

  test('loadMore failure keeps what is shown and flags a retry', () async {
    final container = containerWith(
      _ScriptedParticipants([
        _page(['u-1'], next: 'p2'),
        const AttendanceException('attendance.unavailable', 'x'),
      ]),
    );
    await container.read(provider.future);
    await container.read(provider.notifier).loadMore();
    final state = container.read(provider).value!;
    expect(state.items.map((p) => p.userId), ['u-1']);
    expect(state.loadMoreFailed, isTrue);
  });

  test('refresh reloads the first page', () async {
    final container = containerWith(
      _ScriptedParticipants([
        _page(['u-1'], next: 'p2'),
        _page(['u-9']),
      ]),
    );
    await container.read(provider.future);
    await container.read(provider.notifier).refresh();
    final state = container.read(provider).value!;
    expect(state.items.map((p) => p.userId), ['u-9']);
  });
}
