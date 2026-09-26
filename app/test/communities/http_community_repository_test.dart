import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/http/http_auth_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_community_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_messaging_repository.dart';

import 'community_test_support.dart';

/// The repositories against a scripted server: the exact routes the backend
/// serves, every refusal mapped to its stable code, and anything unreadable
/// reported as such rather than thrown raw.
void main() {
  final base = Uri.parse('https://api.example.org/');

  Future<ApiClient> api(http.Client client, {bool signedIn = true}) async {
    final store = InMemoryTokenStore();
    if (signedIn) {
      await store.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
    }
    return ApiClient(baseUri: base, httpClient: client, tokenStore: store);
  }

  Matcher refusedWith(String code) =>
      throwsA(isA<CommunityException>().having((e) => e.code, 'code', code));

  group('HttpCommunityRepository', () {
    test('lists the viewer’s own communities, a page at a time', () async {
      final server = CommunityServer({
        'GET /communities': (request) => jsonResponse(200, {
          'items': [
            communityJson(id: 'c-1'),
            communityJson(id: 'c-2', status: 'LOCKED'),
          ],
          'nextCursor': request.url.queryParameters['cursor'] == null
              ? 'next page'
              : null,
        }),
      });
      final repo = HttpCommunityRepository(await api(server.client));

      final first = await repo.communities();
      expect(first.items.map((c) => c.id), ['c-1', 'c-2']);
      expect(first.items.every((c) => c.origin == DataOrigin.records), isTrue);
      expect(first.nextCursor, 'next page');

      final second = await repo.communities(cursor: first.nextCursor);
      expect(second.nextCursor, isNull);

      expect(server.requests.first.url.queryParameters, {'scope': 'mine'});
      expect(server.requests.last.url.queryParameters, {
        'scope': 'mine',
        'cursor': 'next page',
      });
      expect(server.requests.first.headers['authorization'], 'Bearer a1');
    });

    test('reads one community by its encoded id', () async {
      final server = CommunityServer({
        'GET /communities/a%2Fb': (_) =>
            jsonResponse(200, communityJson(id: 'a/b', lifecycleVersion: 7)),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      final community = await repo.community('a/b');
      expect(community.id, 'a/b');
      expect(community.lifecycleVersion, 7);
      expect(server.calls, ['GET /communities/a%2Fb']);
    });

    test('reads a roster page by cursor, and never asks for more', () async {
      final server = CommunityServer({
        'GET /communities/c-1/members': (request) => jsonResponse(200, {
          'items': [
            memberJson('u-1'),
            memberJson('u-2', displayName: null, active: false),
          ],
          'nextCursor': 'more',
        }),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      final page = await repo.members('c-1');
      expect(page.items.map((m) => m.userId), ['u-1', 'u-2']);
      expect(page.items.last.active, isFalse);
      expect(page.nextCursor, 'more');
      await repo.members('c-1', cursor: 'more');
      expect(server.requests.first.url.queryParameters, isEmpty);
      expect(server.requests.last.url.queryParameters, {'cursor': 'more'});
      expect(server.requests, hasLength(2));
    });

    test('reports "not found" as gone', () async {
      final server = CommunityServer({
        'GET /communities/c-9': (_) =>
            refusal(404, 'communities.community_not_found'),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      await expectLater(
        repo.community('c-9'),
        throwsA(
          isA<CommunityException>().having((e) => e.isGone, 'gone', true),
        ),
      );
    });

    test('reports a roster refusal as forbidden', () async {
      final server = CommunityServer({
        'GET /communities/c-1/members': (_) =>
            refusal(403, 'communities.capability_required'),
        'GET /communities/c-2/members': (_) =>
            refusal(403, 'identity.permission_denied'),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      for (final id in ['c-1', 'c-2']) {
        await expectLater(
          repo.members(id),
          throwsA(
            isA<CommunityException>().having(
              (e) => e.isForbidden,
              'forbidden',
              true,
            ),
          ),
        );
      }
    });

    test(
      'asks for a sign-in when nobody is signed in, or the session ended',
      () async {
        final nobody = HttpCommunityRepository(
          await api(CommunityServer({}).client, signedIn: false),
        );
        await expectLater(
          nobody.communities(),
          throwsA(
            isA<CommunityException>().having(
              (e) => e.needsSignIn,
              'sign in',
              true,
            ),
          ),
        );

        final ended = CommunityServer({
          'GET /communities': (_) =>
              refusal(401, 'identity.authentication_required'),
          'POST /auth/refresh': (_) => refusal(401, 'identity.refresh_invalid'),
        });
        await expectLater(
          HttpCommunityRepository(await api(ended.client)).communities(),
          refusedWith('identity.authentication_required'),
        );
      },
    );

    test('reports an unreachable server as a network failure', () async {
      final offline = MockClient((_) async => throw http.ClientException('x'));
      await expectLater(
        HttpCommunityRepository(await api(offline)).community('c-1'),
        throwsA(
          isA<CommunityException>().having((e) => e.isNetwork, 'network', true),
        ),
      );
    });

    test(
      'reports what it cannot read as unreadable, never a raw error',
      () async {
        final server = CommunityServer({
          'GET /communities/c-1': (_) =>
              jsonResponse(200, communityJson()..remove('id')),
          'GET /communities': (_) => jsonResponse(200, ['not', 'a', 'page']),
        });
        final repo = HttpCommunityRepository(await api(server.client));
        await expectLater(
          repo.community('c-1'),
          refusedWith('communities.unreadable'),
        );
        await expectLater(
          repo.communities(),
          refusedWith('communities.unreadable'),
        );
      },
    );
  });

  group('HttpCommunityRepository — links, membership, grants, ownership', () {
    final token = 'Tok_${'x' * 39}';

    Map<String, Object?> sentJson(http.Request request) =>
        (jsonDecode(request.body) as Map).cast<String, Object?>();

    void expectNoBody(http.Request request) {
      expect(request.body, isEmpty);
      expect(request.headers.containsKey('content-type'), isFalse);
    }

    test(
      'makes a link on the server’s terms: `{}`, and nothing in it',
      () async {
        final server = CommunityServer({
          'POST /communities/c%2F1/invitations': (_) => jsonResponse(201, {
            'invitation': invitationJson('inv-1', createdBy: 'user-2'),
            'token': token,
          }),
        });
        final repo = HttpCommunityRepository(await api(server.client));
        final created = await repo.createInvitation('c/1');
        expect(created.token, token);
        expect(created.invitation.id, 'inv-1');
        expect(created.invitation.state, InvitationState.active);
        expect(created.invitation.origin, DataOrigin.records);

        final request = server.requests.single;
        expect(request.body, '{}');
        expect(request.headers['content-type'], startsWith('application/json'));
        expect(request.headers['authorization'], 'Bearer a1');
        expect(request.url.query, isEmpty);
      },
    );

    test('lists links a page at a time, and never asks for more', () async {
      final server = CommunityServer({
        'GET /communities/c-1/invitations': (request) => jsonResponse(200, {
          'items': [
            invitationJson('inv-2'),
            invitationJson('inv-1', state: 'EXPIRED'),
          ],
          'nextCursor': request.url.queryParameters['cursor'] == null
              ? 'more'
              : null,
        }),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      final first = await repo.invitations('c-1');
      expect(first.items.map((i) => i.id), ['inv-2', 'inv-1']);
      expect(first.items.last.state, InvitationState.expired);
      expect(first.nextCursor, 'more');
      final second = await repo.invitations('c-1', cursor: 'more');
      expect(second.nextCursor, isNull);
      expect(server.requests.first.url.queryParameters, isEmpty);
      expect(server.requests.last.url.queryParameters, {'cursor': 'more'});
    });

    test('revokes a link, sending no body at all — again alike', () async {
      final server = CommunityServer({
        'POST /communities/c-1/invitations/inv%2F1/revoke': (_) => jsonResponse(
          200,
          invitationJson(
            'inv/1',
            state: 'REVOKED',
            revokedAt: '2026-09-22T08:00:00.000Z',
          ),
        ),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      for (var i = 0; i < 2; i++) {
        final revoked = await repo.revokeInvitation('c-1', 'inv/1');
        expect(revoked.state, InvitationState.revoked);
        expect(revoked.revokedAt, DateTime.utc(2026, 9, 22, 8));
      }
      for (final request in server.requests) {
        expectNoBody(request);
      }
    });

    test(
      'joins with the token in the body alone — 201 and 200 alike',
      () async {
        var joined = false;
        final server = CommunityServer({
          'POST /communities/join': (_) {
            final status = joined ? 200 : 201;
            joined = true;
            return jsonResponse(
              status,
              communityJson(id: 'c-7', operations: ['community.leave']),
            );
          },
        });
        final repo = HttpCommunityRepository(await api(server.client));
        final first = await repo.join(token);
        final again = await repo.join(token);
        for (final community in [first, again]) {
          expect(community.id, 'c-7');
          expect(community.me.standing, CommunityStanding.member);
          expect(community.me.allows(CommunityOperation.leave), isTrue);
        }
        for (final request in server.requests) {
          expect(sentJson(request), {'token': token});
          expect(
            request.url.toString(),
            'https://api.example.org/communities/join',
          );
          expect(
            request.headers['content-type'],
            startsWith('application/json'),
          );
        }
      },
    );

    test(
      'keeps every join refusal’s code and details — never the token',
      () async {
        final answers = <String, http.Response>{
          'invalid': refusal(404, 'communities.invitation_invalid'),
          'removed': refusal(403, 'communities.rejoin_requires_manager'),
          'revoked': refusal(412, 'communities.invitation_revoked'),
          'expired': refusal(412, 'communities.invitation_expired'),
          'exhausted': refusal(412, 'communities.invitation_exhausted'),
          'locked': refusal(412, 'communities.community_locked'),
          'limited': refusal(
            429,
            'communities.too_many_attempts',
            details: {'retryAfterSeconds': 90},
          ),
        };
        late String answering;
        final server = CommunityServer({
          'POST /communities/join': (_) => answers[answering]!,
        });
        final repo = HttpCommunityRepository(await api(server.client));
        final refusals = <String, CommunityException>{};
        for (final key in answers.keys) {
          answering = key;
          try {
            await repo.join(token);
            fail('joined through a refused link');
          } on CommunityException catch (error) {
            refusals[key] = error;
          }
        }
        expect(refusals['invalid']!.code, 'communities.invitation_invalid');
        expect(
          refusals['removed']!.code,
          'communities.rejoin_requires_manager',
        );
        expect(refusals['revoked']!.code, 'communities.invitation_revoked');
        expect(refusals['expired']!.code, 'communities.invitation_expired');
        expect(refusals['exhausted']!.code, 'communities.invitation_exhausted');
        expect(refusals['locked']!.isLocked, isTrue);
        expect(refusals['limited']!.isRateLimited, isTrue);
        expect(refusals['limited']!.retryAfter, const Duration(seconds: 90));
        for (final error in refusals.values) {
          expect(
            '$error ${error.message} ${error.details}',
            isNot(contains(token)),
          );
        }
      },
    );

    test('removes a member by the encoded id: 204, nothing sent', () async {
      final server = CommunityServer({
        'DELETE /communities/c-1/members/u%2F1': (_) => http.Response('', 204),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      await repo.removeMember('c-1', 'u/1');
      expect(server.calls, ['DELETE /communities/c-1/members/u%2F1']);
      expectNoBody(server.requests.single);
    });

    test('leaves, locks and unlocks, sending no body at all', () async {
      final server = CommunityServer({
        'POST /communities/c-1/leave': (_) => http.Response('', 204),
        'POST /communities/c-1/lock': (_) => jsonResponse(
          200,
          communityJson(id: 'c-1', status: 'LOCKED', lifecycleVersion: 2),
        ),
        'POST /communities/c-1/unlock': (_) =>
            jsonResponse(200, communityJson(id: 'c-1', lifecycleVersion: 3)),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      final locked = await repo.lock('c-1');
      expect(locked.isLocked, isTrue);
      expect(locked.lifecycleVersion, 2);
      final unlocked = await repo.unlock('c-1');
      expect(unlocked.isLocked, isFalse);
      expect(unlocked.lifecycleVersion, 3);
      await repo.leave('c-1');
      expect(server.calls, [
        'POST /communities/c-1/lock',
        'POST /communities/c-1/unlock',
        'POST /communities/c-1/leave',
      ]);
      for (final request in server.requests) {
        expectNoBody(request);
      }
    });

    test('reads one member’s grants, by cursor', () async {
      final server = CommunityServer({
        'GET /communities/c-1/grants': (request) => jsonResponse(200, {
          'items': [
            grantJson('g-1', capability: 'community.lock', dormant: true),
          ],
          'nextCursor': request.url.queryParameters['cursor'] == null
              ? 'more'
              : null,
        }),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      final page = await repo.grants('c-1', userId: 'u/2');
      expect(page.items.single.capability, CommunityCapability.lock);
      expect(page.items.single.dormant, isTrue);
      expect(page.nextCursor, 'more');
      await repo.grants('c-1', userId: 'u/2', cursor: 'more');
      expect(server.requests.first.url.queryParameters, {'userId': 'u/2'});
      expect(server.requests.last.url.queryParameters, {
        'userId': 'u/2',
        'cursor': 'more',
      });
    });

    test('grants in the vocabulary’s order; 201 and 200 alike', () async {
      var granted = false;
      final server = CommunityServer({
        'POST /communities/c-1/grants': (_) {
          final status = granted ? 200 : 201;
          final answer = {
            'created': [
              if (!granted) grantJson('g-1'),
              if (!granted) grantJson('g-2', capability: 'community.lock'),
            ],
            'unchanged': [
              if (granted) grantJson('g-1'),
              if (granted) grantJson('g-2', capability: 'community.lock'),
            ],
          };
          granted = true;
          return jsonResponse(status, answer);
        },
      });
      final repo = HttpCommunityRepository(await api(server.client));
      final capabilities = {
        CommunityCapability.lock,
        CommunityCapability.membersView,
      };
      final first = await repo.grant(
        'c-1',
        userId: 'u-2',
        capabilities: capabilities,
      );
      expect(first.created.map((g) => g.grantId), ['g-1', 'g-2']);
      expect(first.unchanged, isEmpty);
      final again = await repo.grant(
        'c-1',
        userId: 'u-2',
        capabilities: capabilities,
      );
      expect(again.created, isEmpty);
      expect(again.unchanged, hasLength(2));
      for (final request in server.requests) {
        expect(sentJson(request), {
          'userId': 'u-2',
          'capabilities': ['community.members.view', 'community.lock'],
        });
      }
    });

    test('revokes a grant by the encoded id: 204, again alike', () async {
      final server = CommunityServer({
        'DELETE /communities/c-1/grants/g%2F1': (_) => http.Response('', 204),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      await repo.revokeGrant('c-1', 'g/1');
      await repo.revokeGrant('c-1', 'g/1');
      expect(
        server.calls,
        everyElement('DELETE /communities/c-1/grants/g%2F1'),
      );
      expectNoBody(server.requests.first);
    });

    test(
      'hands the community over with a PUT, answered as the caller now stands',
      () async {
        final server = CommunityServer({
          'PUT /communities/c-1/owner': (_) => jsonResponse(
            200,
            communityJson(id: 'c-1', operations: ['community.leave']),
          ),
        });
        final repo = HttpCommunityRepository(await api(server.client));
        final community = await repo.transferOwnership('c-1', 'u-2');
        expect(community.me.standing, CommunityStanding.member);
        expect(community.me.operations, {CommunityOperation.leave});
        final request = server.requests.single;
        expect(sentJson(request), {'userId': 'u-2'});
        expect(request.headers['authorization'], 'Bearer a1');
      },
    );

    test('keeps each refusal’s details for the screen to read', () async {
      final server = CommunityServer({
        'POST /communities/c-1/grants': (_) => refusal(
          403,
          'identity.permission_denied',
          details: {'permission': 'messaging.send'},
        ),
        'POST /communities/c-1/invitations': (_) => refusal(
          412,
          'communities.community_locked',
          details: {'act': 'community.members.invite'},
        ),
        'POST /communities/c-1/lock': (_) =>
            refusal(409, 'communities.conflict'),
        'PUT /communities/c-1/owner': (_) => refusal(503, 'unavailable'),
        'DELETE /communities/c-1/members/u-1': (_) =>
            refusal(412, 'communities.owner_not_removable'),
      });
      final repo = HttpCommunityRepository(await api(server.client));
      await expectLater(
        repo.grant(
          'c-1',
          userId: 'u-2',
          capabilities: {CommunityCapability.chatPost},
        ),
        throwsA(
          isA<CommunityException>()
              .having((e) => e.isForbidden, 'forbidden', isTrue)
              .having((e) => e.details, 'details', {
                'permission': 'messaging.send',
              }),
        ),
      );
      await expectLater(
        repo.createInvitation('c-1'),
        throwsA(
          isA<CommunityException>()
              .having((e) => e.isLocked, 'locked', isTrue)
              .having(
                (e) => e.details['act'],
                'act',
                'community.members.invite',
              ),
        ),
      );
      await expectLater(
        repo.lock('c-1'),
        throwsA(
          isA<CommunityException>()
              .having((e) => e.isConflict, 'conflict', isTrue)
              .having((e) => e.details, 'details', isEmpty),
        ),
      );
      await expectLater(
        repo.transferOwnership('c-1', 'u-2'),
        throwsA(
          isA<CommunityException>().having(
            (e) => e.isUnavailable,
            'unavailable',
            isTrue,
          ),
        ),
      );
      await expectLater(
        repo.removeMember('c-1', 'u-1'),
        refusedWith('communities.owner_not_removable'),
      );
    });

    test(
      'renews an expired session once, then sends the same write again',
      () async {
        var refreshes = 0;
        final server = CommunityServer({
          'POST /auth/refresh': (_) {
            refreshes += 1;
            return jsonResponse(200, {
              'accessToken': 'a2',
              'refreshToken': 'r2',
            });
          },
          'PUT /communities/c-1/owner': (request) =>
              request.headers['authorization'] == 'Bearer a2'
              ? jsonResponse(200, communityJson(id: 'c-1'))
              : refusal(401, 'identity.authentication_required'),
          'POST /communities/join': (request) =>
              request.headers['authorization'] == 'Bearer a2'
              ? jsonResponse(201, communityJson(id: 'c-7'))
              : refusal(401, 'identity.authentication_required'),
        });
        final repo = HttpCommunityRepository(await api(server.client));
        expect((await repo.transferOwnership('c-1', 'u-2')).id, 'c-1');
        expect(server.calls, [
          'PUT /communities/c-1/owner',
          'POST /auth/refresh',
          'PUT /communities/c-1/owner',
        ]);
        expect(sentJson(server.requests.first), {'userId': 'u-2'});
        expect(sentJson(server.requests.last), {'userId': 'u-2'});
        expect(server.requests.last.headers['authorization'], 'Bearer a2');
        expect(refreshes, 1);

        // Already renewed: a join goes through at once, token in the body.
        expect((await repo.join(token)).id, 'c-7');
        expect(sentJson(server.requests.last), {'token': token});
        expect(refreshes, 1);
      },
    );

    test(
      'asks for a sign-in, sending nothing, when nobody is signed in',
      () async {
        final server = CommunityServer({});
        final repo = HttpCommunityRepository(
          await api(server.client, signedIn: false),
        );
        await expectLater(
          repo.join(token),
          refusedWith('identity.authentication_required'),
        );
        await expectLater(
          repo.leave('c-1'),
          refusedWith('identity.authentication_required'),
        );
        expect(server.requests, isEmpty);
      },
    );

    test('reports an unreachable server as a network failure', () async {
      final offline = MockClient((_) async => throw http.ClientException('x'));
      final repo = HttpCommunityRepository(await api(offline));
      await expectLater(repo.join(token), refusedWith('network.unreachable'));
      await expectLater(
        repo.removeMember('c-1', 'u-1'),
        refusedWith('network.unreachable'),
      );
    });

    test(
      'reports what it cannot read as unreadable, never a raw error',
      () async {
        final server = CommunityServer({
          'POST /communities/c-1/invitations': (_) => jsonResponse(201, {
            'invitation': invitationJson('inv-1')..remove('id'),
            'token': token,
          }),
          'POST /communities/c-2/invitations': (_) =>
              jsonResponse(201, {'invitation': invitationJson('inv-1')}),
          'POST /communities/c-1/lock': (_) => jsonResponse(200, ['locked']),
          'POST /communities/c-1/leave': (_) => http.Response('<html>', 200),
          'GET /communities/c-1/grants': (_) =>
              jsonResponse(200, {'items': 'none'}),
        });
        final repo = HttpCommunityRepository(await api(server.client));
        for (final attempt in <Future<Object?> Function()>[
          () => repo.createInvitation('c-1'),
          () => repo.createInvitation('c-2'),
          () => repo.lock('c-1'),
          () => repo.leave('c-1'),
        ]) {
          await expectLater(attempt(), refusedWith('communities.unreadable'));
        }
        // A page whose items are not a list is an empty page, as for reads.
        expect((await repo.grants('c-1', userId: 'u-1')).items, isEmpty);
      },
    );
  });

  group('HttpMessagingRepository.conversationForCommunity', () {
    Map<String, Object?> chat() => {
      'id': 'conv-7',
      'type': 'CHANNEL',
      'communityId': 'c/1',
      'title': 'مجتمع الخادم',
      'counterpartUserId': null,
      'memberCount': 30000,
      'myRole': 'MEMBER',
      'canPost': false,
      'canManageMembers': false,
      'lastSequence': 0,
      'lastReadSequence': 0,
      'unreadCount': 0,
      'lastMessage': null,
      'createdAt': '2026-09-01T08:00:00.000Z',
      'activityAt': '2026-09-01T08:00:00.000Z',
    };

    test('resolves the chat from the community, by the encoded id', () async {
      final server = CommunityServer({
        'GET /messaging/communities/c%2F1/conversation': (_) =>
            jsonResponse(200, chat()),
      });
      final client = await api(server.client);
      final repo = HttpMessagingRepository(client, HttpAuthRepository(client));
      final conversation = await repo.conversationForCommunity('c/1');
      expect(conversation.id, 'conv-7');
      expect(conversation.type, ConversationType.channel);
      expect(conversation.communityId, 'c/1');
      expect(conversation.canPost, isFalse);
    });

    test('maps its refusals to the server’s codes', () async {
      final server = CommunityServer({
        'GET /messaging/communities/gone/conversation': (_) =>
            refusal(404, 'messaging.conversation_not_found'),
        'GET /messaging/communities/busy/conversation': (_) =>
            refusal(429, 'messaging.too_many_community_chat_lookups'),
      });
      final client = await api(server.client);
      final repo = HttpMessagingRepository(client, HttpAuthRepository(client));
      for (final (id, code) in [
        ('gone', 'messaging.conversation_not_found'),
        ('busy', 'messaging.too_many_community_chat_lookups'),
      ]) {
        await expectLater(
          repo.conversationForCommunity(id),
          throwsA(
            isA<MessagingException>().having((e) => e.code, 'code', code),
          ),
        );
      }
    });
  });
}
