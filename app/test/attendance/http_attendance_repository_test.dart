import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/http/http_attendance_repository.dart';

/// [HttpAttendanceRepository] against a scripted server: the exact POST route
/// and body, a 201 (new) and a 200 (replay) read alike, and every refusal or
/// unreadable body mapped to [AttendanceException] with the server's code and
/// details — never thrown raw.
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

  Map<String, Object?> snapshotBody() => {
    'id': 'snap-1',
    'communityId': 'c-1',
    'liveSessionId': 's/1',
    'recordedBy': {'userId': 'u-1', 'displayName': 'أم أحمد'},
    'observationRule': 'provider_registry_v1',
    'observationStartedAt': '2026-01-01T00:00:00.000Z',
    'observedAt': '2026-01-01T00:00:01.000Z',
    'recordedAt': '2026-01-01T00:00:02.000Z',
    'connectedCount': 9,
    'connectingCount': 1,
  };

  group('HttpAttendanceRepository.record', () {
    test('POSTs the key to the encoded session path with the bearer', () async {
      late http.BaseRequest seen;
      late String sentBody;
      final client = MockClient((request) async {
        seen = request;
        sentBody = request.body;
        return http.Response(
          jsonEncode(snapshotBody()),
          201,
          headers: {'content-type': 'application/json'},
        );
      });
      final repo = HttpAttendanceRepository(await api(client));

      final view = await repo.record('s/1', clientRequestId: 'key-abcdefgh');
      expect(view.id, 'snap-1');
      expect(view.connectedCount, 9);
      expect(view.connectingCount, 1);
      expect(view.recordedBy.displayName, 'أم أحمد');
      expect(view.origin, DataOrigin.records);
      expect(seen.method, 'POST');
      expect(seen.url.path, '/attendance/live-sessions/s%2F1/snapshots');
      expect(seen.headers['authorization'], 'Bearer a1');
      expect(jsonDecode(sentBody), {'clientRequestId': 'key-abcdefgh'});
    });

    test('reads a 200 replay exactly like a 201 (same view)', () async {
      final repo = HttpAttendanceRepository(
        await api(serving(200, snapshotBody())),
      );
      final view = await repo.record('s-1', clientRequestId: 'key-abcdefgh');
      expect(view.id, 'snap-1');
    });

    test(
      'maps a 429 to AttendanceException with the code and retryAfter',
      () async {
        final repo = HttpAttendanceRepository(
          await api(
            serving(429, {
              'error': {
                'code': 'attendance.too_many_snapshots',
                'message': 'slow down',
                'details': {'retryAfterSeconds': 30},
              },
            }),
          ),
        );
        await expectLater(
          repo.record('s-1', clientRequestId: 'key-abcdefgh'),
          throwsA(
            isA<AttendanceException>()
                .having((e) => e.rateLimited, 'rateLimited', isTrue)
                .having((e) => e.retryAfterSeconds, 'retryAfterSeconds', 30),
          ),
        );
      },
    );

    test('maps the 503 observation-unavailable code', () async {
      final repo = HttpAttendanceRepository(
        await api(
          serving(503, {
            'error': {
              'code': 'attendance.observation_unavailable',
              'message': 'no',
            },
          }),
        ),
      );
      await expectLater(
        repo.record('s-1', clientRequestId: 'key-abcdefgh'),
        throwsA(
          isA<AttendanceException>().having(
            (e) => e.observationUnavailable,
            'observationUnavailable',
            isTrue,
          ),
        ),
      );
    });

    test('reports an unreadable body as attendance.unreadable', () async {
      // A snapshot whose id is not a string: the model refuses to read it.
      final repo = HttpAttendanceRepository(
        await api(serving(201, {'id': 123})),
      );
      await expectLater(
        repo.record('s-1', clientRequestId: 'key-abcdefgh'),
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
}
