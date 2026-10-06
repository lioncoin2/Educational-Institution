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
}
