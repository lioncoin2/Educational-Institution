import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/http/http_live_repository.dart';

/// [HttpLiveRepository] against a scripted server: the exact current-session
/// route, `{session: null}` read as "none running", and every refusal or
/// unreadable body mapped to [LiveException] rather than thrown raw.
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

  group('HttpLiveRepository.currentSession', () {
    test(
      'parses the running session, encodes the id, sends the bearer',
      () async {
        late http.BaseRequest seen;
        final client = MockClient((request) async {
          seen = request;
          return http.Response(
            jsonEncode({
              'session': {
                'id': 's-1',
                'communityId': 'c/1',
                'state': 'live',
                'hostUserId': 'u-host',
                'startedAt': '2026-01-01T00:00:00.000Z',
                'speakerCount': 3,
                'me': {
                  'role': 'moderator',
                  'isHost': true,
                  'canModerate': true,
                },
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        });
        final repo = HttpLiveRepository(await api(client));

        final session = await repo.currentSession('c/1');
        expect(session, isNotNull);
        expect(session!.id, 's-1');
        expect(session.isLive, isTrue);
        expect(session.speakerCount, 3);
        expect(session.me.canModerate, isTrue);
        expect(session.origin, DataOrigin.records);
        expect(seen.url.path, '/live/communities/c%2F1/sessions/current');
        expect(seen.headers['authorization'], 'Bearer a1');
      },
    );

    test('returns null when no session is running ({session: null})', () async {
      final repo = HttpLiveRepository(
        await api(serving(200, {'session': null})),
      );
      expect(await repo.currentSession('c-1'), isNull);
    });

    test('returns null when the answer has no session key', () async {
      final repo = HttpLiveRepository(await api(serving(200, const {})));
      expect(await repo.currentSession('c-1'), isNull);
    });

    test('maps a refusal to LiveException with the server’s code', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(404, {
            'error': {'code': 'live.community_not_found', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.currentSession('c-1'),
        throwsA(
          isA<LiveException>()
              .having((e) => e.code, 'code', 'live.community_not_found')
              .having((e) => e.isGone, 'isGone', isTrue),
        ),
      );
    });

    test(
      'reports an unreadable body as live.unreadable, not a raw throw',
      () async {
        // A session whose id is not a string: the domain refuses to read it.
        final repo = HttpLiveRepository(
          await api(
            serving(200, {
              'session': {'id': 123, 'communityId': 'c-1'},
            }),
          ),
        );
        await expectLater(
          repo.currentSession('c-1'),
          throwsA(
            isA<LiveException>().having(
              (e) => e.code,
              'code',
              'live.unreadable',
            ),
          ),
        );
      },
    );
  });
}
