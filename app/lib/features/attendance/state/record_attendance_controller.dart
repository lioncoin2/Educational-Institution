import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/client_ids.dart';
import '../../../data/models/attendance.dart';
import '../../../providers/app_providers.dart';

/// Where one recorder's press stands, as the attendance screen shows it.
sealed class RecordAttendanceState {
  const RecordAttendanceState();
}

/// Nothing pressed yet — or ready for a fresh press after a result.
final class RecordIdle extends RecordAttendanceState {
  const RecordIdle();
}

/// A press is on its way; the button waits.
final class RecordInFlight extends RecordAttendanceState {
  const RecordInFlight();
}

/// The snapshot this press took — counts only.
final class RecordSuccess extends RecordAttendanceState {
  const RecordSuccess(this.snapshot);

  final SnapshotView snapshot;
}

/// The press did not go through; [code] is the server's refusal. The key is
/// kept, so a retry is the same press (same observation key), never a new one.
final class RecordFailure extends RecordAttendanceState {
  const RecordFailure(this.code);

  final String code;
}

/// Records attendance on a press (attendance.md §17/§18 S1).
///
/// One idempotency key per press: minted once when a new press starts, kept
/// across retries of that press (a retry resends the same key, so the server
/// stores one snapshot however many times the network fails, §8), and cleared
/// on a result so the next press mints a fresh one. The button is disabled
/// while a request is in flight ([RecordInFlight]).
///
/// This never decides authorization. The screen gates the button on the
/// server's own answers (the community capability and the live session's
/// `me.canModerate`), and the backend is the final authority on the POST.
class RecordAttendanceController extends Notifier<RecordAttendanceState> {
  RecordAttendanceController(this.communityId);

  /// The community whose record screen this backs — the controller's scope.
  final String communityId;

  /// The key of the press in progress, kept for its retries; null between
  /// presses.
  String? _pendingKey;

  @override
  RecordAttendanceState build() => const RecordIdle();

  /// Takes a snapshot of [liveSessionId]. A fresh press (from idle or after a
  /// result) mints a new key; a retry after a failure reuses the kept key.
  Future<void> record(String liveSessionId) async {
    if (state is RecordInFlight) return;
    final key = _pendingKey ??= newClientId();
    state = const RecordInFlight();
    try {
      final snapshot = await ref
          .read(attendanceRepositoryProvider)
          .record(liveSessionId, clientRequestId: key);
      if (!ref.mounted) return;
      _pendingKey = null; // a result: the next press is a fresh one
      state = RecordSuccess(snapshot);
    } on AttendanceException catch (error) {
      if (!ref.mounted) return;
      state = RecordFailure(error.code); // key kept, so a retry is this press
    }
  }
}

final recordAttendanceProvider = NotifierProvider.autoDispose
    .family<RecordAttendanceController, RecordAttendanceState, String>(
      RecordAttendanceController.new,
      retry: (_, _) => null,
    );
