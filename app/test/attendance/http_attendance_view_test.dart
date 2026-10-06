import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/repositories/http/http_attendance_repository.dart';

/// [HttpAttendanceRepository] view paths against a scripted server: exact
/// routes, query params included only when given (never a `limit`), opaque
/// cursor forwarding, and every refusal mapped to [AttendanceException].
void main() {
  final base = Uri.parse('https://api.example.org/');

  Future<ApiClient> api(http.Client client) async {
    final store = InMemoryTokenStore();
    await store.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
    return ApiClient(baseUri: base, httpClient: client, tokenStore: store);
  }

  http.Client serving(int status, Object body) => MockClient(
    (_) async => http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json'},
    ),
  );

  Map<String, Object?> snapJson(String id) => {
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

  http.Response ok(Object body) => http.Response(
    jsonEncode(body),
    200,
    headers: {'content-type': 'application/json'},
  );

  group('snapshots', () {
    test(
      'GETs the encoded community path; cursor only, no limit, bearer',
      () async {
        late http.BaseRequest seen;
        final client = MockClient((request) async {
          seen = request;
          return ok({
            'items': [snapJson('a')],
            'nextCursor': 'cur-2',
          });
        });
        final repo = HttpAttendanceRepository(await api(client));

        final page = await repo.snapshots('c/1', cursor: 'cur-1');
        expect(page.items.single.id, 'a');
        expect(page.nextCursor, 'cur-2');
        expect(seen.url.path, '/attendance/communities/c%2F1/snapshots');
        expect(seen.url.queryParameters['cursor'], 'cur-1');
        expect(seen.url.queryParameters.containsKey('limit'), isFalse);
        expect(seen.url.queryParameters.containsKey('liveSessionId'), isFalse);
        expect(seen.headers['authorization'], 'Bearer a1');
      },
    );

    test(
      'omits cursor when null and includes liveSessionId when given',
      () async {
        late http.BaseRequest seen;
        final client = MockClient((request) async {
          seen = request;
          return ok({'items': <Object>[], 'nextCursor': null});
        });
        final repo = HttpAttendanceRepository(await api(client));
        await repo.snapshots('c-1', liveSessionId: 's-9');
        expect(seen.url.queryParameters.containsKey('cursor'), isFalse);
        expect(seen.url.queryParameters['liveSessionId'], 's-9');
        expect(seen.url.queryParameters.containsKey('limit'), isFalse);
      },
    );

    test('maps 404 community_not_found', () async {
      final repo = HttpAttendanceRepository(
        await api(
          serving(404, {
            'error': {
              'code': 'attendance.community_not_found',
              'message': 'no',
            },
          }),
        ),
      );
      await expectLater(
        repo.snapshots('c-1'),
        throwsA(
          isA<AttendanceException>().having(
            (e) => e.communityNotFound,
            'communityNotFound',
            isTrue,
          ),
        ),
      );
    });

    test(
      'maps 403 not_allowed, 412 community_not_open, 422 cursor_invalid, 503',
      () async {
        for (final (status, code, check)
            in <(int, String, bool Function(AttendanceException))>[
              (403, 'attendance.not_allowed', (e) => e.notAllowed),
              (412, 'attendance.community_not_open', (e) => e.communityNotOpen),
              (422, 'attendance.cursor_invalid', (e) => e.cursorInvalid),
              (503, 'attendance.unavailable', (e) => e.isUnavailable),
            ]) {
          final repo = HttpAttendanceRepository(
            await api(
              serving(status, {
                'error': {'code': code, 'message': 'x'},
              }),
            ),
          );
          await expectLater(
            repo.snapshots('c-1', cursor: 'x'),
            throwsA(isA<AttendanceException>().having(check, code, isTrue)),
          );
        }
      },
    );
  });

  group('snapshot', () {
    test('GETs the encoded snapshot path and parses the view', () async {
      late http.BaseRequest seen;
      final client = MockClient((request) async {
        seen = request;
        return ok(snapJson('snap-7'));
      });
      final repo = HttpAttendanceRepository(await api(client));
      final view = await repo.snapshot('snap/7');
      expect(view.id, 'snap-7');
      expect(view.connectedCount, 3);
      expect(seen.url.path, '/attendance/snapshots/snap%2F7');
    });

    test('maps 404 snapshot_not_found', () async {
      final repo = HttpAttendanceRepository(
        await api(
          serving(404, {
            'error': {'code': 'attendance.snapshot_not_found', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.snapshot('s-1'),
        throwsA(
          isA<AttendanceException>().having(
            (e) => e.snapshotNotFound,
            'snapshotNotFound',
            isTrue,
          ),
        ),
      );
    });

    test('reports an unreadable body as attendance.unreadable', () async {
      final repo = HttpAttendanceRepository(
        await api(serving(200, {'id': 123})),
      );
      await expectLater(
        repo.snapshot('s-1'),
        throwsA(
          isA<AttendanceException>().having(
            (e) => e.code,
            'code',
            'attendance.unreadable',
          ),
        ),
      );
    });
  });

  group('participants', () {
    test(
      'GETs the encoded path; sends connection + cursor, never a limit',
      () async {
        late http.BaseRequest seen;
        final client = MockClient((request) async {
          seen = request;
          return ok({
            'items': [
              {'userId': 'u-1', 'displayName': 'x', 'connection': 'CONNECTED'},
            ],
            'nextCursor': null,
          });
        });
        final repo = HttpAttendanceRepository(await api(client));
        final page = await repo.participants(
          's/1',
          connection: SnapshotConnection.connecting,
          cursor: 'p-2',
        );
        expect(page.items.single.userId, 'u-1');
        expect(seen.url.path, '/attendance/snapshots/s%2F1/participants');
        expect(seen.url.queryParameters['connection'], 'CONNECTING');
        expect(seen.url.queryParameters['cursor'], 'p-2');
        expect(seen.url.queryParameters.containsKey('limit'), isFalse);
      },
    );

    test('omits connection and cursor when not supplied', () async {
      late http.BaseRequest seen;
      final client = MockClient((request) async {
        seen = request;
        return ok({'items': <Object>[], 'nextCursor': null});
      });
      final repo = HttpAttendanceRepository(await api(client));
      await repo.participants('s-1');
      expect(seen.url.queryParameters.containsKey('connection'), isFalse);
      expect(seen.url.queryParameters.containsKey('cursor'), isFalse);
    });

    test('maps 404 snapshot_not_found', () async {
      final repo = HttpAttendanceRepository(
        await api(
          serving(404, {
            'error': {'code': 'attendance.snapshot_not_found', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.participants('s-1'),
        throwsA(
          isA<AttendanceException>().having(
            (e) => e.snapshotNotFound,
            'snapshotNotFound',
            isTrue,
          ),
        ),
      );
    });
  });
}
