import '../../../app/app_config.dart';
import '../../models/attendance.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// In-memory stand-in for `/attendance`, for the demo build and widget tests.
///
/// It keeps the server's record-only shape and its idempotency rule: a press
/// with a key already seen returns the very same snapshot, never a second one
/// (attendance.md §8/§17). Everything it emits is invented, marked
/// [DataOrigin.mock], and never presented as real. No media, ever — a snapshot
/// is data only.
class MockAttendanceRepository implements AttendanceRepository {
  MockAttendanceRepository({
    this.latency = AppConfig.fakeLatency,
    this.clock = DateTime.now,
    int connectedCount = 12,
    int connectingCount = 2,
  }) : _connected = connectedCount,
       _connecting = connectingCount;

  final Duration latency;

  /// "Now", for an invented snapshot's instants. A test may fix it.
  final DateTime Function() clock;

  final int _connected;
  final int _connecting;

  /// Snapshots already taken, by their idempotency key, so a replay returns
  /// the same one — the server's rule, reproduced.
  final Map<String, SnapshotView> _byKey = {};

  var _serial = 0;

  @override
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  }) async {
    await Future<void>.delayed(latency);
    final existing = _byKey[clientRequestId];
    if (existing != null) return existing;
    final now = clock();
    final snapshot = SnapshotView(
      id: 'mock-snapshot-${++_serial}',
      communityId: 'mock-community',
      liveSessionId: liveSessionId,
      recordedBy: const SnapshotRecorder(
        userId: 'mock-teacher',
        displayName: 'المعلّم (تجريبي)',
      ),
      observationRule: 'provider_registry_v1',
      observationStartedAt: now,
      observedAt: now,
      recordedAt: now,
      connectedCount: _connected,
      connectingCount: _connecting,
      origin: DataOrigin.mock,
    );
    _byKey[clientRequestId] = snapshot;
    return snapshot;
  }

  // ── Viewing (attendance.md §15.1) ─────────────────────────────────────────
  // Invented, stable across repeated calls: a community's snapshots and a
  // snapshot's participants are generated once and cached, so the same id is
  // always the same object and paging is determinate.

  static const _pageSize = 3;

  final Map<String, List<SnapshotView>> _byCommunity = {};
  final Map<String, SnapshotView> _byId = {};
  final Map<String, List<SnapshotParticipant>> _participantsById = {};

  @override
  Future<SnapshotPage> snapshots(
    String communityId, {
    String? liveSessionId,
    String? cursor,
  }) async {
    await Future<void>.delayed(latency);
    var all = _snapshotsFor(communityId);
    if (liveSessionId != null) {
      all = [
        for (final s in all)
          if (s.liveSessionId == liveSessionId) s,
      ];
    }
    final (items, next) = _slice(all, cursor);
    return SnapshotPage(items: items, nextCursor: next);
  }

  @override
  Future<SnapshotView> snapshot(String snapshotId) async {
    await Future<void>.delayed(latency);
    return _byId[snapshotId] ??= _invent(snapshotId, 'mock-community', 0);
  }

  @override
  Future<SnapshotParticipantPage> participants(
    String snapshotId, {
    SnapshotConnection? connection,
    String? cursor,
  }) async {
    await Future<void>.delayed(latency);
    var all = _participantsFor(snapshotId);
    if (connection != null) {
      all = [
        for (final p in all)
          if (p.connection == connection) p,
      ];
    }
    final (items, next) = _slice(all, cursor);
    return SnapshotParticipantPage(items: items, nextCursor: next);
  }

  List<SnapshotView> _snapshotsFor(String communityId) =>
      _byCommunity.putIfAbsent(communityId, () {
        final list = [
          for (var i = 0; i < 7; i++)
            _invent('mock-snapshot-$communityId-$i', communityId, i),
        ];
        for (final s in list) {
          _byId[s.id] = s;
        }
        return list;
      });

  SnapshotView _invent(String id, String communityId, int i) {
    final at = clock().subtract(Duration(hours: i));
    return SnapshotView(
      id: id,
      communityId: communityId,
      liveSessionId: 'mock-session-$communityId',
      recordedBy: const SnapshotRecorder(
        userId: 'mock-teacher',
        displayName: 'المعلّم (تجريبي)',
      ),
      observationRule: 'provider_registry_v1',
      observationStartedAt: at,
      observedAt: at,
      recordedAt: at,
      connectedCount: 10 + i,
      connectingCount: i % 3,
      origin: DataOrigin.mock,
    );
  }

  List<SnapshotParticipant> _participantsFor(String snapshotId) =>
      _participantsById.putIfAbsent(snapshotId, () {
        final header = _byId[snapshotId];
        final connected = header?.connectedCount ?? 12;
        final connecting = header?.connectingCount ?? 2;
        return <SnapshotParticipant>[
          for (var i = 0; i < connected; i++)
            SnapshotParticipant(
              userId: 'mock-user-c-${i.toString().padLeft(3, '0')}',
              displayName: 'مشارك ${i + 1} (تجريبي)',
              connection: SnapshotConnection.connected,
              origin: DataOrigin.mock,
            ),
          for (var i = 0; i < connecting; i++)
            SnapshotParticipant(
              userId: 'mock-user-g-${i.toString().padLeft(3, '0')}',
              displayName: 'مشارك قيد الاتصال ${i + 1} (تجريبي)',
              connection: SnapshotConnection.connecting,
              origin: DataOrigin.mock,
            ),
        ]..sort((a, b) => a.userId.compareTo(b.userId));
      });

  /// A page from [all] at the opaque [cursor] — the next offset as a string,
  /// so paging is determinate and the cursor stays opaque to callers.
  (List<T>, String?) _slice<T>(List<T> all, String? cursor) {
    final start = (cursor == null ? 0 : int.tryParse(cursor) ?? 0).clamp(
      0,
      all.length,
    );
    final end = (start + _pageSize).clamp(0, all.length);
    return (all.sublist(start, end), end < all.length ? '$end' : null);
  }
}
