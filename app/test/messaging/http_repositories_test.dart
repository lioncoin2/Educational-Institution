import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/repositories/http/http_auth_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_messaging_repository.dart';

http.Response json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

http.Response error(int status, String code) => json(status, {
  'error': {'kind': 'x', 'code': code, 'message': code},
});

const user = {
  'id': 'u-1',
  'displayName': 'Student',
  'status': 'ACTIVE',
  'roles': ['STUDENT'],
  'permissions': ['messaging.read', 'messaging.send', 'files.upload'],
};

Map<String, Object?> messageJson({
  required int sequence,
  String type = 'TEXT',
  String? body = 'hi',
  List<Object?> attachments = const [],
}) => {
  'id': 'm-$sequence',
  'conversationId': 'c-1',
  'sequence': sequence,
  'senderId': 'u-1',
  'type': type,
  'body': body,
  'replyToMessageId': null,
  'clientMessageId': 'key',
  'createdAt': '2026-09-01T08:00:00.000Z',
  'editedAt': null,
  'deletedAt': null,
  'attachments': attachments,
};

/// A scripted backend: records every request, answers by method + path.
class FakeServer {
  FakeServer(this.routes);

  final Map<String, http.Response Function(http.Request request)> routes;
  final List<http.Request> requests = [];

  late final client = MockClient((request) async {
    requests.add(request);
    final handler = routes['${request.method} ${request.url.path}'];
    if (handler == null) return error(404, 'not_found');
    return handler(request);
  });

  List<String> get calls => [
    for (final r in requests) '${r.method} ${r.url.path}',
  ];
}

void main() {
  final base = Uri.parse('https://api.example.org/');

  Future<(ApiClient, InMemoryTokenStore)> api(FakeServer server) async {
    final store = InMemoryTokenStore();
    return (
      ApiClient(baseUri: base, httpClient: server.client, tokenStore: store),
      store,
    );
  }

  group('HttpAuthRepository', () {
    test('signs in, keeps the tokens, and knows who is signed in', () async {
      final server = FakeServer({
        'POST /auth/login': (request) {
          final body = jsonDecode(request.body) as Map<String, Object?>;
          expect(body['identifier'], 'student@institution.test');
          expect((body['device']! as Map)['platform'], isA<String>());
          return json(200, {
            'tokenType': 'Bearer',
            'accessToken': 'a1',
            'expiresIn': 900,
            'refreshToken': 'r1',
            'refreshTokenExpiresAt': '2026-10-01T00:00:00.000Z',
            'sessionId': 's1',
            'user': user,
          });
        },
      });
      final (client, store) = await api(server);
      final auth = HttpAuthRepository(client);
      final signedIn = await auth.signIn(
        identifier: ' student@institution.test ',
        password: 'pw',
      );
      expect(signedIn.id, 'u-1');
      expect((await store.read())?.refreshToken, 'r1');
      expect((await auth.currentUser())?.id, 'u-1');
    });

    test('reports a refusal with the server code', () async {
      final server = FakeServer({
        'POST /auth/login': (_) => error(401, 'identity.invalid_credentials'),
      });
      final (client, _) = await api(server);
      await expectLater(
        HttpAuthRepository(client).signIn(identifier: 'x', password: 'y'),
        throwsA(
          isA<AuthException>().having(
            (e) => e.code,
            'code',
            'identity.invalid_credentials',
          ),
        ),
      );
    });

    test('signs out locally even when the server cannot be reached', () async {
      final server = FakeServer({
        'POST /auth/logout': (_) => throw http.ClientException('offline'),
      });
      final (client, store) = await api(server);
      await store.write(const Tokens(accessToken: 'a', refreshToken: 'r'));
      await HttpAuthRepository(client).signOut();
      expect(await store.read(), isNull);
    });
  });

  group('HttpMessagingRepository', () {
    Future<HttpMessagingRepository> repository(FakeServer server) async {
      final (client, store) = await api(server);
      await store.write(const Tokens(accessToken: 'a', refreshToken: 'r'));
      server.routes['GET /auth/me'] ??= (_) => json(200, user);
      return HttpMessagingRepository(client, HttpAuthRepository(client));
    }

    test('pages messages with sequence cursors', () async {
      final server = FakeServer({
        'GET /messaging/conversations/c-1/messages': (request) {
          expect(request.url.queryParameters, {'before': '31', 'limit': '30'});
          return json(200, {
            'items': [messageJson(sequence: 30)],
            'hasOlder': true,
            'hasNewer': true,
            'lastReadSequence': 40,
            'senders': [
              {'userId': 'u-1', 'displayName': 'Student'},
            ],
          });
        },
      });
      final page = await (await repository(server)).messages('c-1', before: 31);
      expect(page.items.single.sequence, 30);
      expect(page.hasOlder, isTrue);
    });

    test('sends text with the client key', () async {
      final server = FakeServer({
        'POST /messaging/conversations/c-1/messages/text': (request) {
          expect(jsonDecode(request.body), {
            'clientMessageId': 'key-1',
            'body': 'السلام',
          });
          return json(201, messageJson(sequence: 7, body: 'السلام'));
        },
      });
      final sent = await (await repository(server))
          .sendText('c-1', clientMessageId: 'key-1', body: 'السلام');
      expect(sent.sequence, 7);
    });

    test('maps refusals to MessagingException with the server code', () async {
      final server = FakeServer({
        'POST /messaging/conversations/c-1/messages/text': (_) =>
            error(403, 'messaging.posting_not_allowed'),
      });
      await expectLater(
        (await repository(server))
            .sendText('c-1', clientMessageId: 'k', body: 'x'),
        throwsA(
          isA<MessagingException>().having(
            (e) => e.code,
            'code',
            'messaging.posting_not_allowed',
          ),
        ),
      );
    });

    final image = OutgoingFile(
      bytes: Uint8List.fromList([0x89, 0x50, 0x4e, 0x47]),
      fileName: 'board.png',
      contentType: 'image/png',
      kind: AttachmentKind.image,
      width: 10,
      height: 10,
    );

    Map<String, http.Response Function(http.Request)> uploadRoutes({
      required http.Response Function(http.Request) send,
    }) => {
      'POST /files/uploads': (request) {
        expect(jsonDecode(request.body), {
          'kind': 'IMAGE',
          'contentType': 'image/png',
          'byteSize': 4,
          'fileName': 'board.png',
          'width': 10,
          'height': 10,
        });
        return json(201, {
          'asset': {'id': 'asset-1', 'status': 'PENDING'},
          'upload': {
            'url': '/files/local/tok?exp=1&ct=image%2Fpng&max=4&sig=s',
            'method': 'PUT',
            'headers': {'content-type': 'image/png'},
            'expiresAt': '2026-09-01T08:15:00.000Z',
          },
        });
      },
      'PUT /files/local/tok': (request) {
        expect(request.headers['content-type'], startsWith('image/png'));
        expect(request.headers.containsKey('authorization'), isFalse);
        expect(request.bodyBytes, [0x89, 0x50, 0x4e, 0x47]);
        return http.Response('', 201);
      },
      'POST /files/uploads/asset-1/complete': (_) =>
          json(200, {'id': 'asset-1'}),
      'POST /messaging/conversations/c-1/messages/image': send,
    };

    test('uploads, verifies, then sends an image referencing it', () async {
      final server = FakeServer(
        uploadRoutes(
          send: (request) {
            expect(jsonDecode(request.body), {
              'clientMessageId': 'img-1',
              'fileAssetId': 'asset-1',
              'caption': 'الواجب',
            });
            return json(
              201,
              messageJson(sequence: 9, type: 'IMAGE', body: 'الواجب'),
            );
          },
        ),
      );
      final sent = await (await repository(server)).sendImage(
        'c-1',
        clientMessageId: 'img-1',
        image: image,
        caption: 'الواجب',
      );
      expect(sent.type, MessageType.image);
      expect(server.calls, [
        'POST /files/uploads',
        'PUT /files/local/tok',
        'POST /files/uploads/asset-1/complete',
        'POST /messaging/conversations/c-1/messages/image',
      ]);
    });

    test('a retry after a failed send reuses the upload instead of uploading again', () async {
      var attempts = 0;
      final server = FakeServer(
        uploadRoutes(
          send: (_) {
            attempts++;
            return attempts == 1
                ? error(503, 'unavailable')
                : json(
                    201,
                    messageJson(sequence: 9, type: 'IMAGE', body: null),
                  );
          },
        ),
      );
      final repo = await repository(server);
      await expectLater(
        repo.sendImage('c-1', clientMessageId: 'img-2', image: image),
        throwsA(isA<MessagingException>()),
      );
      await repo.sendImage('c-1', clientMessageId: 'img-2', image: image);
      expect(
        server.calls.where((c) => c == 'POST /files/uploads'),
        hasLength(1),
      );
      expect(
        server.calls.where((c) => c.endsWith('/messages/image')),
        hasLength(2),
      );
    });

    test('resolves attachment links against the API', () async {
      final server = FakeServer({
        'GET /messaging/conversations/c-1/messages/m-1/attachments/a-1/link':
            (_) => json(200, {
              'url': '/files/local/x?sig=y',
              'expiresAt': '2026-09-01T08:05:00.000Z',
            }),
      });
      final url = await (await repository(server))
          .attachmentUrl('c-1', 'm-1', 'a-1');
      expect(url.toString(), 'https://api.example.org/files/local/x?sig=y');
    });

    test('knows the viewer from the session', () async {
      final server = FakeServer({});
      expect(await (await repository(server)).viewerId(), 'u-1');
    });
  });
}
