import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';

/// The viewing wire models, parsed defensively: an unknown connection is
/// [SnapshotConnection.unknown], a page reuses [SnapshotView] for its items and
/// carries the opaque cursor, and an unreadable row is dropped, never fatal.
void main() {
  Map<String, Object?> snap(String id) => {
    'id': id,
    'communityId': 'c-1',
    'liveSessionId': 's-1',
    'recordedBy': {'userId': 'u-1', 'displayName': 'أم أحمد'},
    'observationRule': 'provider_registry_v1',
    'observationStartedAt': '2026-01-01T00:00:00.000Z',
    'observedAt': '2026-01-01T00:00:00.000Z',
    'recordedAt': '2026-01-01T00:00:00.000Z',
    'connectedCount': 3,
    'connectingCount': 1,
  };

  group('SnapshotConnection.fromWire', () {
    test('maps the known wire values', () {
      expect(
        SnapshotConnection.fromWire('CONNECTED'),
        SnapshotConnection.connected,
      );
      expect(
        SnapshotConnection.fromWire('CONNECTING'),
        SnapshotConnection.connecting,
      );
    });
    test('maps anything else to unknown', () {
      expect(
        SnapshotConnection.fromWire('PRESENT'),
        SnapshotConnection.unknown,
      );
      expect(SnapshotConnection.fromWire(null), SnapshotConnection.unknown);
      expect(SnapshotConnection.fromWire(7), SnapshotConnection.unknown);
    });
    test('exposes the wire value for the query param', () {
      expect(SnapshotConnection.connected.wire, 'CONNECTED');
      expect(SnapshotConnection.connecting.wire, 'CONNECTING');
    });
  });

  group('SnapshotParticipant.fromJson', () {
    test('reads the id, name and connection', () {
      final p = SnapshotParticipant.fromJson(const {
        'userId': 'u-1',
        'displayName': 'أم أحمد',
        'connection': 'CONNECTED',
      });
      expect(p.userId, 'u-1');
      expect(p.displayName, 'أم أحمد');
      expect(p.connection, SnapshotConnection.connected);
      expect(p.origin, DataOrigin.records);
    });
    test('leaves the name null when the server resolved none', () {
      final p = SnapshotParticipant.fromJson(const {
        'userId': 'u-1',
        'displayName': null,
        'connection': 'CONNECTING',
      });
      expect(p.displayName, isNull);
      expect(p.connection, SnapshotConnection.connecting);
    });
    test('maps an unknown connection defensively', () {
      final p = SnapshotParticipant.fromJson(const {
        'userId': 'u-1',
        'connection': 'WHAT',
      });
      expect(p.connection, SnapshotConnection.unknown);
    });
    test('carries a given origin (mock in the demo)', () {
      final p = SnapshotParticipant.fromJson(const {
        'userId': 'u-1',
        'connection': 'CONNECTED',
      }, origin: DataOrigin.mock);
      expect(p.origin, DataOrigin.mock);
    });
    test('throws FormatException without an id', () {
      expect(
        () => SnapshotParticipant.fromJson(const {'connection': 'CONNECTED'}),
        throwsFormatException,
      );
    });
  });

  group('SnapshotPage.fromJson', () {
    test('reads items (reusing SnapshotView) and the opaque cursor', () {
      final page = SnapshotPage.fromJson({
        'items': [snap('a'), snap('b')],
        'nextCursor': 'cur-2',
      });
      expect(page.items, hasLength(2));
      expect(page.items.first, isA<SnapshotView>());
      expect(page.items.first.id, 'a');
      expect(page.nextCursor, 'cur-2');
    });
    test('null nextCursor on the last page', () {
      final page = SnapshotPage.fromJson({
        'items': [snap('a')],
        'nextCursor': null,
      });
      expect(page.nextCursor, isNull);
    });
    test('drops an unreadable item, never fatal to the page', () {
      final page = SnapshotPage.fromJson({
        'items': [
          snap('a'),
          {'id': 123},
        ],
        'nextCursor': null,
      });
      expect(page.items, hasLength(1));
      expect(page.items.single.id, 'a');
    });
    test('carries the origin into its items', () {
      final page = SnapshotPage.fromJson({
        'items': [snap('a')],
      }, origin: DataOrigin.mock);
      expect(page.items.single.origin, DataOrigin.mock);
    });
  });

  group('SnapshotParticipantPage.fromJson', () {
    test('reads participants and the cursor; drops unreadable rows', () {
      final page = SnapshotParticipantPage.fromJson({
        'items': [
          {'userId': 'u-1', 'connection': 'CONNECTED'},
          {'connection': 'CONNECTED'}, // no id → dropped
        ],
        'nextCursor': 'p-2',
      });
      expect(page.items, hasLength(1));
      expect(page.items.single.userId, 'u-1');
      expect(page.nextCursor, 'p-2');
    });
  });

  group('AttendanceException view classifiers', () {
    test('classify the view refusals by code', () {
      expect(
        const AttendanceException(
          'attendance.community_not_found',
          '',
        ).communityNotFound,
        isTrue,
      );
      expect(
        const AttendanceException(
          'attendance.snapshot_not_found',
          '',
        ).snapshotNotFound,
        isTrue,
      );
      expect(
        const AttendanceException(
          'attendance.cursor_invalid',
          '',
        ).cursorInvalid,
        isTrue,
      );
    });
  });
}
