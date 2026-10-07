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

  group('HttpLiveRepository.getSession', () {
    // The full moderator's view the backend returns by id (LiveSessionView):
    // the session's own fields, the viewer's `me` block and the moderation
    // counters. GET /live/sessions/:id returns it DIRECTLY — not under a
    // `{session}` key the way /current does.
    Map<String, Object?> fullSession() => {
      'id': 's-1',
      'communityId': 'c-1',
      'state': 'live',
      'stateVersion': 7,
      'hostUserId': 'u-host',
      'startedAt': '2026-01-01T00:00:00.000Z',
      'endedAt': null,
      'endReason': null,
      'speakerCount': 2,
      'participantCap': 300,
      'presenterUserIds': ['t-1', 't-2'],
      'me': {
        'role': 'moderator',
        'isHost': true,
        'canJoin': true,
        'canRaiseHand': false,
        'canModerate': true,
        'canEnd': true,
        'canPresent': true,
        'presenting': false,
        'hand': {'requestId': 'r-1', 'state': 'pending'},
      },
      'moderation': {
        'pendingHands': 3,
        'violations': 0,
        'lastViolationAt': null,
      },
    };

    test(
      'parses the full view (not wrapped), encodes the id, sends the bearer',
      () async {
        late http.BaseRequest seen;
        final client = MockClient((request) async {
          seen = request;
          return http.Response(
            jsonEncode(fullSession()),
            200,
            headers: {'content-type': 'application/json'},
          );
        });
        final repo = HttpLiveRepository(await api(client));

        final session = await repo.getSession('s/1');
        expect(session.id, 's-1');
        expect(session.isLive, isTrue);
        expect(session.stateVersion, 7);
        expect(session.participantCap, 300);
        expect(session.presenterUserIds, ['t-1', 't-2']);
        expect(session.speakerCount, 2);
        expect(session.me.canModerate, isTrue);
        expect(session.me.canEnd, isTrue);
        expect(session.me.hand!.state, SpeakerRequestState.pending);
        expect(session.moderation!.pendingHands, 3);
        expect(session.origin, DataOrigin.records);
        expect(seen.url.path, '/live/sessions/s%2F1');
        expect(seen.headers['authorization'], 'Bearer a1');
      },
    );

    test('maps "not found" to LiveException.isGone', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(404, {
            'error': {'code': 'live.session_not_found', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.getSession('s-1'),
        throwsA(
          isA<LiveException>()
              .having((e) => e.code, 'code', 'live.session_not_found')
              .having((e) => e.isGone, 'isGone', isTrue),
        ),
      );
    });

    test('maps "not a moderator" to LiveException.isForbidden', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(403, {
            'error': {'code': 'live.not_a_moderator', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.getSession('s-1'),
        throwsA(
          isA<LiveException>()
              .having((e) => e.code, 'code', 'live.not_a_moderator')
              .having((e) => e.isForbidden, 'isForbidden', isTrue),
        ),
      );
    });

    test('maps an auth refusal to LiveException.needsSignIn', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(401, {
            'error': {
              'code': 'identity.authentication_required',
              'message': 'no',
            },
          }),
        ),
      );
      await expectLater(
        repo.getSession('s-1'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.needsSignIn,
            'needsSignIn',
            isTrue,
          ),
        ),
      );
    });

    test('reports an unreadable body as live.unreadable', () async {
      // A session whose id is not a string: the domain refuses to read it.
      final repo = HttpLiveRepository(
        await api(serving(200, {'id': 123, 'communityId': 'c-1'})),
      );
      await expectLater(
        repo.getSession('s-1'),
        throwsA(
          isA<LiveException>().having((e) => e.code, 'code', 'live.unreadable'),
        ),
      );
    });

    test('surfaces a server failure, never a silent empty answer', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(503, {
            'error': {'code': 'unavailable', 'message': 'down'},
          }),
        ),
      );
      await expectLater(
        repo.getSession('s-1'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.isUnavailable,
            'isUnavailable',
            isTrue,
          ),
        ),
      );
    });
  });

  group('HttpLiveRepository.hands', () {
    // A page of the moderators' hand queue: a pending hand (no connection yet)
    // and a granted one (name resolved, media observed), then a next cursor.
    Map<String, Object?> handsPage() => {
      'items': [
        {
          'id': 'h-1',
          'sessionId': 's-1',
          'userId': 'u-1',
          'state': 'pending',
          'requestedAt': '2026-01-01T00:01:00.000Z',
          'grantedAt': null,
          'decidedAt': null,
          'displayName': 'طالبة',
        },
        {
          'id': 'h-2',
          'sessionId': 's-1',
          'userId': 'u-2',
          'state': 'granted',
          'requestedAt': '2026-01-01T00:00:30.000Z',
          'grantedAt': '2026-01-01T00:02:00.000Z',
          'decidedAt': '2026-01-01T00:02:00.000Z',
          'displayName': 'طالب',
          'media': 'connected',
        },
      ],
      'nextCursor': 'cur-2',
    };

    test(
      'parses a page, forwards state/cursor/limit, encodes the id',
      () async {
        late http.BaseRequest seen;
        final client = MockClient((request) async {
          seen = request;
          return http.Response(
            jsonEncode(handsPage()),
            200,
            headers: {'content-type': 'application/json'},
          );
        });
        final repo = HttpLiveRepository(await api(client));

        final page = await repo.hands(
          's/1',
          state: LiveHandsFilter.pending,
          cursor: 'c0',
          limit: 20,
        );
        expect(page.items, hasLength(2));
        expect(page.items.first.id, 'h-1');
        expect(page.items.first.state, SpeakerRequestState.pending);
        expect(page.items.first.displayName, 'طالبة');
        expect(page.items.first.grantedAt, isNull);
        expect(page.items.first.media, isNull);
        expect(page.items[1].state, SpeakerRequestState.granted);
        expect(page.items[1].grantedAt, isNotNull);
        expect(page.items[1].media, LiveObservedMedia.connected);
        expect(page.nextCursor, 'cur-2');
        expect(page.origin, DataOrigin.records);
        expect(seen.url.path, '/live/sessions/s%2F1/hands');
        expect(seen.url.queryParameters['state'], 'pending');
        expect(seen.url.queryParameters['cursor'], 'c0');
        expect(seen.url.queryParameters['limit'], '20');
      },
    );

    test('sends no optional query when none is given', () async {
      late http.BaseRequest seen;
      final client = MockClient((request) async {
        seen = request;
        return http.Response(
          jsonEncode({'items': <Object?>[], 'nextCursor': null}),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final repo = HttpLiveRepository(await api(client));

      final page = await repo.hands('s-1');
      expect(page.items, isEmpty);
      expect(page.nextCursor, isNull);
      expect(seen.url.queryParameters, isEmpty);
    });

    test('forwards the granted filter as its wire value', () async {
      late http.BaseRequest seen;
      final client = MockClient((request) async {
        seen = request;
        return http.Response(
          jsonEncode({'items': <Object?>[], 'nextCursor': null}),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final repo = HttpLiveRepository(await api(client));

      await repo.hands('s-1', state: LiveHandsFilter.granted);
      expect(seen.url.queryParameters['state'], 'granted');
      expect(seen.url.queryParameters.containsKey('cursor'), isFalse);
      expect(seen.url.queryParameters.containsKey('limit'), isFalse);
    });

    test('maps "not a moderator" to LiveException.isForbidden', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(403, {
            'error': {'code': 'live.not_a_moderator', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.hands('s-1'),
        throwsA(
          isA<LiveException>()
              .having((e) => e.code, 'code', 'live.not_a_moderator')
              .having((e) => e.isForbidden, 'isForbidden', isTrue),
        ),
      );
    });

    test('maps "not found" to LiveException.isGone', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(404, {
            'error': {'code': 'live.session_not_found', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.hands('s-1'),
        throwsA(isA<LiveException>().having((e) => e.isGone, 'isGone', isTrue)),
      );
    });

    test('maps an auth refusal to LiveException.needsSignIn', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(401, {
            'error': {
              'code': 'identity.authentication_required',
              'message': 'no',
            },
          }),
        ),
      );
      await expectLater(
        repo.hands('s-1'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.needsSignIn,
            'needsSignIn',
            isTrue,
          ),
        ),
      );
    });

    test('reports one unreadable hand as live.unreadable', () async {
      // An item with no id: the hand refuses to read, so the page does.
      final repo = HttpLiveRepository(
        await api(
          serving(200, {
            'items': [
              {
                'sessionId': 's-1',
                'userId': 'u-1',
                'state': 'pending',
                'requestedAt': '2026-01-01T00:00:00.000Z',
              },
            ],
            'nextCursor': null,
          }),
        ),
      );
      await expectLater(
        repo.hands('s-1'),
        throwsA(
          isA<LiveException>().having((e) => e.code, 'code', 'live.unreadable'),
        ),
      );
    });

    test('surfaces a server failure, never a silent empty page', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(503, {
            'error': {'code': 'unavailable', 'message': 'down'},
          }),
        ),
      );
      await expectLater(
        repo.hands('s-1'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.isUnavailable,
            'isUnavailable',
            isTrue,
          ),
        ),
      );
    });
  });
}
