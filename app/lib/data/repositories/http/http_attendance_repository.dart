import '../../api/api_client.dart';
import '../../models/attendance.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// [AttendanceRepository] against the real backend (`/attendance`).
///
/// Record-only: one POST takes a snapshot of who Live holds connected now and
/// returns the stored header. The live-session id is encoded into the path;
/// the body carries the caller's idempotency key and nothing else — the
/// recorder, the community and whom to count are the server's to know (§11,
/// §15.1). A 201 (new) and a 200 (idempotent replay) are the same
/// [SnapshotView] to the caller, so the status is never surfaced. Every
/// transport or parsing failure becomes an [AttendanceException], keeping the
/// server's code and details.
class HttpAttendanceRepository implements AttendanceRepository {
  HttpAttendanceRepository(this._api);

  final ApiClient _api;

  @override
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  }) => _call(() async {
    final json = await _api.post(
      '/attendance/live-sessions/${Uri.encodeComponent(liveSessionId)}/snapshots',
      body: {'clientRequestId': clientRequestId},
    );
    return SnapshotView.fromJson(json, origin: DataOrigin.records);
  });

  @override
  Future<SnapshotPage> snapshots(
    String communityId, {
    String? liveSessionId,
    String? cursor,
  }) => _call(() async {
    final json = await _api.get(
      '/attendance/communities/${Uri.encodeComponent(communityId)}/snapshots',
      query: {'liveSessionId': ?liveSessionId, 'cursor': ?cursor},
    );
    return SnapshotPage.fromJson(json, origin: DataOrigin.records);
  });

  @override
  Future<SnapshotView> snapshot(String snapshotId) => _call(() async {
    final json = await _api.get(
      '/attendance/snapshots/${Uri.encodeComponent(snapshotId)}',
    );
    return SnapshotView.fromJson(json, origin: DataOrigin.records);
  });

  @override
  Future<SnapshotParticipantPage> participants(
    String snapshotId, {
    SnapshotConnection? connection,
    String? cursor,
  }) => _call(() async {
    final json = await _api.get(
      '/attendance/snapshots/${Uri.encodeComponent(snapshotId)}/participants',
      query: {'connection': ?connection?.wire, 'cursor': ?cursor},
    );
    return SnapshotParticipantPage.fromJson(json, origin: DataOrigin.records);
  });

  static const _unreadable = AttendanceException(
    'attendance.unreadable',
    'The server sent something this app cannot read.',
  );

  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw AttendanceException(
        error.code,
        error.message,
        details: error.details ?? const {},
      );
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }
}
