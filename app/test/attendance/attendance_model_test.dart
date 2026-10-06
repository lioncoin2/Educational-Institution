import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';

/// The attendance wire model, parsed defensively like communities and live: a
/// required field it cannot read is a [FormatException], a missing count is
/// zero, and a refusal is sorted by its stable code — never by its reason.
void main() {
  Map<String, Object?> snapshotJson({
    Object? id = 'snap-1',
    Object? recordedBy = const {'userId': 'u-1', 'displayName': 'أم أحمد'},
    Object? connectedCount = 12,
    Object? connectingCount = 2,
  }) => {
    'id': id,
    'communityId': 'c-1',
    'liveSessionId': 's-1',
    'recordedBy': recordedBy,
    'observationRule': 'provider_registry_v1',
    'observationStartedAt': '2026-01-01T00:00:00.000Z',
    'observedAt': '2026-01-01T00:00:01.000Z',
    'recordedAt': '2026-01-01T00:00:02.000Z',
    'connectedCount': connectedCount,
    'connectingCount': connectingCount,
  };

  group('SnapshotView.fromJson', () {
    test('reads the counts, the recorder and the instants', () {
      final view = SnapshotView.fromJson(snapshotJson());
      expect(view.id, 'snap-1');
      expect(view.communityId, 'c-1');
      expect(view.liveSessionId, 's-1');
      expect(view.recordedBy.userId, 'u-1');
      expect(view.recordedBy.displayName, 'أم أحمد');
      expect(view.observationRule, 'provider_registry_v1');
      expect(view.connectedCount, 12);
      expect(view.connectingCount, 2);
      expect(
        view.recordedAt.isAtSameMomentAs(DateTime.utc(2026, 1, 1, 0, 0, 2)),
        isTrue,
      );
      expect(view.observedAt.isBefore(view.recordedAt), isTrue);
      expect(view.origin, DataOrigin.records); // the default
    });

    test('leaves the recorder name null when the server resolved none', () {
      final view = SnapshotView.fromJson(
        snapshotJson(recordedBy: const {'userId': 'u-1', 'displayName': null}),
      );
      expect(view.recordedBy.userId, 'u-1');
      expect(view.recordedBy.displayName, isNull);
    });

    test('defaults missing counts to zero', () {
      final json = snapshotJson()
        ..remove('connectedCount')
        ..remove('connectingCount');
      final view = SnapshotView.fromJson(json);
      expect(view.connectedCount, 0);
      expect(view.connectingCount, 0);
    });

    test('carries the origin it is given (mock in the demo)', () {
      final view = SnapshotView.fromJson(
        snapshotJson(),
        origin: DataOrigin.mock,
      );
      expect(view.origin, DataOrigin.mock);
      expect(view.origin.isMock, isTrue);
    });

    test('throws FormatException on a malformed id, recorder or date', () {
      expect(
        () => SnapshotView.fromJson(snapshotJson(id: 123)),
        throwsFormatException,
      );
      expect(
        () => SnapshotView.fromJson(snapshotJson(recordedBy: 'nope')),
        throwsFormatException,
      );
      expect(
        () => SnapshotView.fromJson(
          snapshotJson(recordedBy: const {'displayName': 'x'}),
        ),
        throwsFormatException,
      );
      final undated = snapshotJson()..remove('recordedAt');
      expect(() => SnapshotView.fromJson(undated), throwsFormatException);
    });
  });

  group('AttendanceException', () {
    test('classifies refusals by code, not by reason', () {
      expect(
        const AttendanceException(
          'attendance.session_not_found',
          '',
        ).sessionNotFound,
        isTrue,
      );
      expect(
        const AttendanceException('attendance.not_allowed', '').notAllowed,
        isTrue,
      );
      expect(
        const AttendanceException(
          'attendance.session_not_live',
          '',
        ).sessionNotLive,
        isTrue,
      );
      expect(
        const AttendanceException(
          'attendance.community_not_open',
          '',
        ).communityNotOpen,
        isTrue,
      );
      expect(
        const AttendanceException(
          'attendance.too_many_snapshots',
          '',
        ).rateLimited,
        isTrue,
      );
      expect(
        const AttendanceException(
          'attendance.observation_unavailable',
          '',
        ).observationUnavailable,
        isTrue,
      );
      expect(
        const AttendanceException('attendance.unavailable', '').isUnavailable,
        isTrue,
      );
      expect(
        const AttendanceException(
          'identity.authentication_required',
          '',
        ).needsSignIn,
        isTrue,
      );
      expect(
        const AttendanceException('network.unreachable', '').isNetwork,
        isTrue,
      );
      // The code is what it carries; it is in toString, the reason rides along.
      expect(
        const AttendanceException('attendance.unreadable', 'bad').toString(),
        contains('attendance.unreadable'),
      );
    });

    test('reads retryAfterSeconds from the details when present', () {
      const limited = AttendanceException(
        'attendance.too_many_snapshots',
        'slow down',
        details: {'retryAfterSeconds': 30},
      );
      expect(limited.retryAfterSeconds, 30);
      expect(const AttendanceException('x', 'y').retryAfterSeconds, isNull);
    });
  });
}
