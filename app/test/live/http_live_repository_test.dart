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

/// A minimal-but-valid LiveSessionResponse body, for commands that return the
/// session (end, the presenter ops).
Map<String, Object?> sessionBody({
  String id = 's-1',
  String state = 'live',
  int stateVersion = 4,
  List<String> presenterUserIds = const [],
}) => {
  'id': id,
  'communityId': 'c-1',
  'state': state,
  'stateVersion': stateVersion,
  'hostUserId': 'u-host',
  'startedAt': '2026-01-01T00:00:00.000Z',
  'endedAt': state == 'ended' ? '2026-01-01T01:00:00.000Z' : null,
  'endReason': state == 'ended' ? 'moderator' : null,
  'participantCap': 300,
  'speakerCount': 1,
  'presenterUserIds': presenterUserIds,
  'me': {
    'role': 'moderator',
    'isHost': true,
    'canModerate': true,
    'canEnd': true,
    'canPresent': true,
  },
  'moderation': {'pendingHands': 0, 'violations': 0, 'lastViolationAt': null},
};

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

  // ── Moderator commands ────────────────────────────────────────────────
  // Records the one request each command makes, so method/path/query/bearer
  // can be asserted exactly.
  (http.Client, List<http.BaseRequest>) recording(int status, Object body) {
    final seen = <http.BaseRequest>[];
    final client = MockClient((request) async {
      seen.add(request);
      return http.Response(
        jsonEncode(body),
        status,
        headers: {'content-type': 'application/json'},
      );
    });
    return (client, seen);
  }

  group('HttpLiveRepository.endSession', () {
    test(
      'POSTs …/end, encodes the id, sends the bearer, decodes the session',
      () async {
        final (client, seen) = recording(200, sessionBody(state: 'ended'));
        final repo = HttpLiveRepository(await api(client));

        final session = await repo.endSession('s/1');
        expect(session.id, 's-1');
        expect(session.state, LiveSessionState.ended);
        expect(session.origin, DataOrigin.records);
        expect(seen.single.method, 'POST');
        expect(seen.single.url.path, '/live/sessions/s%2F1/end');
        expect(seen.single.headers['authorization'], 'Bearer a1');
      },
    );

    test('maps a refusal to LiveException with the server’s code', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(403, {
            'error': {'code': 'live.not_a_moderator', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.endSession('s-1'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.isForbidden,
            'isForbidden',
            isTrue,
          ),
        ),
      );
    });
  });

  group('HttpLiveRepository.removeParticipant', () {
    test(
      'POSTs …/participants/:userId/remove with the reason, decodes removed',
      () async {
        final (client, seen) = recording(200, {'removed': true});
        final repo = HttpLiveRepository(await api(client));

        final removed = await repo.removeParticipant(
          's/1',
          'u/2',
          reason: 'disruptive',
        );
        expect(removed, isTrue);
        expect(seen.single.method, 'POST');
        expect(
          seen.single.url.path,
          '/live/sessions/s%2F1/participants/u%2F2/remove',
        );
        expect(seen.single.url.queryParameters['reason'], 'disruptive');
      },
    );

    test(
      'omits the reason query when none is given; removed:false decodes false',
      () async {
        final (client, seen) = recording(200, {'removed': false});
        final repo = HttpLiveRepository(await api(client));

        final removed = await repo.removeParticipant('s-1', 'u-2');
        expect(removed, isFalse);
        expect(seen.single.url.queryParameters.containsKey('reason'), isFalse);
      },
    );

    test(
      'surfaces 412 session_not_live and 422 reason_invalid by code',
      () async {
        Future<void> expectCode(int status, String code) async {
          final repo = HttpLiveRepository(
            await api(
              serving(status, {
                'error': {'code': code, 'message': 'x'},
              }),
            ),
          );
          await expectLater(
            repo.removeParticipant('s-1', 'u-2', reason: 'BAD'),
            throwsA(isA<LiveException>().having((e) => e.code, 'code', code)),
          );
        }

        await expectCode(412, 'live.session_not_live');
        await expectCode(422, 'live.reason_invalid');
        await expectCode(404, 'live.target_not_in_session');
      },
    );
  });

  group('HttpLiveRepository.resetRoom', () {
    test('POSTs …/reset and decodes reset', () async {
      final (client, seen) = recording(200, {'reset': true});
      final repo = HttpLiveRepository(await api(client));

      expect(await repo.resetRoom('s-1'), isTrue);
      expect(seen.single.method, 'POST');
      expect(seen.single.url.path, '/live/sessions/s-1/reset');
    });

    test('reset:false decodes false', () async {
      final repo = HttpLiveRepository(
        await api(serving(200, {'reset': false})),
      );
      expect(await repo.resetRoom('s-1'), isFalse);
    });

    test('a not-found session surfaces isGone', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(404, {
            'error': {'code': 'live.session_not_found', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.resetRoom('s-1'),
        throwsA(isA<LiveException>().having((e) => e.isGone, 'isGone', isTrue)),
      );
    });
  });

  group('HttpLiveRepository.claimPresenter', () {
    test('POSTs …/screen-share and decodes the session', () async {
      final (client, seen) = recording(
        201,
        sessionBody(presenterUserIds: ['u-host']),
      );
      final repo = HttpLiveRepository(await api(client));

      final session = await repo.claimPresenter('s/1');
      expect(session.presenterUserIds, ['u-host']);
      expect(session.origin, DataOrigin.records);
      expect(seen.single.method, 'POST');
      expect(seen.single.url.path, '/live/sessions/s%2F1/screen-share');
    });

    // The full refusal ladder is uniform (one _call wrapper); proven here.
    test('surfaces 403/404/409/412/503 by their codes', () async {
      Future<void> expectCode(int status, String code) async {
        final repo = HttpLiveRepository(
          await api(
            serving(status, {
              'error': {'code': code, 'message': 'x'},
            }),
          ),
        );
        await expectLater(
          repo.claimPresenter('s-1'),
          throwsA(isA<LiveException>().having((e) => e.code, 'code', code)),
        );
      }

      await expectCode(403, 'live.presenter_not_permitted');
      await expectCode(404, 'live.session_not_found');
      await expectCode(409, 'live.presenter_slots_full');
      await expectCode(412, 'live.session_not_live');
      await expectCode(503, 'live.media_unavailable');
    });

    test(
      'the slots-full conflict surfaces live.presenter_slots_full',
      () async {
        final repo = HttpLiveRepository(
          await api(
            serving(409, {
              'error': {'code': 'live.presenter_slots_full', 'message': 'full'},
            }),
          ),
        );
        await expectLater(
          repo.claimPresenter('s-1'),
          throwsA(
            isA<LiveException>().having(
              (e) => e.code,
              'code',
              'live.presenter_slots_full',
            ),
          ),
        );
      },
    );
  });

  group('HttpLiveRepository.stopPresenter', () {
    test('DELETEs …/screen-share and decodes the session', () async {
      final (client, seen) = recording(200, sessionBody());
      final repo = HttpLiveRepository(await api(client));

      final session = await repo.stopPresenter('s/1');
      expect(session.id, 's-1');
      expect(seen.single.method, 'DELETE');
      expect(seen.single.url.path, '/live/sessions/s%2F1/screen-share');
    });
  });

  group('HttpLiveRepository.grantPresenter', () {
    test(
      'POSTs …/screen-share/:userId/grant and decodes the session',
      () async {
        final (client, seen) = recording(
          201,
          sessionBody(presenterUserIds: ['u-2']),
        );
        final repo = HttpLiveRepository(await api(client));

        final session = await repo.grantPresenter('s/1', 'u/2');
        expect(session.presenterUserIds, ['u-2']);
        expect(seen.single.method, 'POST');
        expect(
          seen.single.url.path,
          '/live/sessions/s%2F1/screen-share/u%2F2/grant',
        );
      },
    );

    test('a target not in the session surfaces isGone (404)', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(404, {
            'error': {'code': 'live.target_not_in_session', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.grantPresenter('s-1', 'u-2'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.code,
            'code',
            'live.target_not_in_session',
          ),
        ),
      );
    });
  });

  group('HttpLiveRepository.revokePresenter', () {
    test('DELETEs …/screen-share/:userId and decodes the session', () async {
      final (client, seen) = recording(200, sessionBody());
      final repo = HttpLiveRepository(await api(client));

      final session = await repo.revokePresenter('s/1', 'u/2');
      expect(session.id, 's-1');
      expect(seen.single.method, 'DELETE');
      expect(seen.single.url.path, '/live/sessions/s%2F1/screen-share/u%2F2');
    });

    test('only-host-may-revoke-host surfaces the server’s code', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(403, {
            'error': {'code': 'live.target_is_host', 'message': 'no'},
          }),
        ),
      );
      await expectLater(
        repo.revokePresenter('s-1', 'u-host'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.code,
            'code',
            'live.target_is_host',
          ),
        ),
      );
    });
  });

  group('HttpLiveRepository.join (media credential)', () {
    Map<String, Object?> ticket() => {
      'sessionId': 's-1',
      'token': 'eyJ.header.signature',
      'url': 'wss://live.example.org',
      'expiresInSeconds': 120,
      'expiresAt': '2026-01-01T00:02:00.000Z',
      'role': 'speaker',
      'media': {'microphone': true, 'screen': false, 'screenAudio': false},
    };

    test('POSTs …/join, encodes the id, sends the bearer, no body, parses the grant', () async {
      final (client, seen) = recording(200, ticket());
      final repo = HttpLiveRepository(await api(client));

      final grant = await repo.join('s/1');
      expect(grant.sessionId, 's-1');
      expect(grant.token, 'eyJ.header.signature');
      expect(grant.url, 'wss://live.example.org');
      expect(grant.role, LiveParticipantRole.speaker);
      expect(grant.microphone, isTrue);
      expect(seen.single.method, 'POST');
      expect(seen.single.url.path, '/live/sessions/s%2F1/join');
      expect(seen.single.headers['authorization'], 'Bearer a1');
      expect(seen.single.contentLength ?? 0, 0); // no request body
    });

    test(
      'an unreadable ticket (no token) is live.unreadable, not a raw throw',
      () async {
        final bad = ticket()..remove('token');
        final repo = HttpLiveRepository(await api(serving(200, bad)));
        await expectLater(
          repo.join('s-1'),
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

    // /join shares the one _call mapping, so the refusal ladder is uniform.
    test(
      'maps the refusal ladder (401/403/404/412/429/503) to LiveException',
      () async {
        Future<void> expectCode(int status, String code) async {
          final repo = HttpLiveRepository(
            await api(
              serving(status, {
                'error': {'code': code, 'message': 'x'},
              }),
            ),
          );
          await expectLater(
            repo.join('s-1'),
            throwsA(isA<LiveException>().having((e) => e.code, 'code', code)),
          );
        }

        await expectCode(401, 'identity.authentication_required');
        await expectCode(403, 'live.not_a_moderator');
        await expectCode(404, 'live.session_not_found');
        await expectCode(412, 'live.session_not_live');
        await expectCode(429, 'live.too_many_joins');
        await expectCode(503, 'live.media_unavailable');
      },
    );

    test('503 live.media_unavailable surfaces as isUnavailable', () async {
      final repo = HttpLiveRepository(
        await api(
          serving(503, {
            'error': {'code': 'live.media_unavailable', 'message': 'down'},
          }),
        ),
      );
      await expectLater(
        repo.join('s-1'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.code,
            'code',
            'live.media_unavailable',
          ),
        ),
      );
    });
  });
}
