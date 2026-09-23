import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/realtime/websocket_realtime_client.dart';
import 'package:web_socket/testing.dart';
import 'package:web_socket/web_socket.dart';

import 'realtime_frames_test.dart' show messageSentJson;

/// The server's end of one connection: every frame the client sent, and a
/// way to answer.
class ServerEnd {
  ServerEnd(this.socket, {required this.autoPong}) {
    socket.events.listen((event) {
      switch (event) {
        case TextDataReceived(:final text):
          final frame = (jsonDecode(text) as Map).cast<String, Object?>();
          frames.add(frame);
          if (autoPong && frame['type'] == 'ping') send({'type': 'pong'});
        case BinaryDataReceived():
          break;
        case CloseReceived():
          closed = event;
      }
    });
  }

  final WebSocket socket;
  bool autoPong;
  final frames = <Map<String, Object?>>[];
  CloseReceived? closed;

  void send(Map<String, Object?> frame) =>
      socket.sendText(jsonEncode({'version': 1, ...frame}));

  void ready({Duration expiresIn = const Duration(minutes: 15)}) => send({
    'type': 'ready',
    'connectionId': 'conn',
    'userId': 'u-1',
    'expiresAt': DateTime.now().add(expiresIn).toUtc().toIso8601String(),
    'heartbeatSeconds': 25,
  });

  Future<void> close(int code) => socket.close(code);

  Iterable<Map<String, Object?>> ofType(String type) =>
      frames.where((f) => f['type'] == type);
}

/// Hands the client fake sockets, and keeps the server's end of each.
class FakeServer {
  final ends = <ServerEnd>[];
  final urls = <Uri>[];
  int refuseNext = 0;
  bool autoPong = true;

  Future<WebSocket> connect(Uri url) async {
    urls.add(url);
    if (refuseNext > 0) {
      refuseNext -= 1;
      throw WebSocketException('connection refused');
    }
    final (client, server) = fakes();
    ends.add(ServerEnd(server, autoPong: autoPong));
    return client;
  }

  ServerEnd get last => ends.last;
}

/// The token source, as ApiClient behaves: a renewal gives a new token,
/// unless the session is over (null) or the server is unreachable.
class FakeTokens {
  int renewals = 0;
  bool sessionOver = false;
  bool unreachable = false;

  String get current => 'token-${renewals + 1}';

  Future<String?> call({bool renew = false}) async {
    if (renew) {
      if (unreachable) {
        throw const ApiException(
          status: 0,
          code: 'network.unreachable',
          message: 'offline',
        );
      }
      if (sessionOver) return null;
      renewals += 1;
    }
    return current;
  }
}

const fast = RealtimeTiming(
  handshakeTimeout: Duration(milliseconds: 300),
  heartbeatInterval: Duration(hours: 1),
  pongTimeout: Duration(milliseconds: 40),
  renewBeforeExpiry: Duration(milliseconds: 50),
  minimumRenewalDelay: Duration(milliseconds: 10),
  subscribeTimeout: Duration(milliseconds: 150),
  backoffBase: Duration(milliseconds: 5),
  backoffMax: Duration(milliseconds: 20),
);

Future<void> eventually(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 3));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('a condition never became true');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

final endpoint = Uri.parse('wss://api.institution.test/realtime');

void main() {
  late FakeServer server;
  late FakeTokens tokens;
  late WebSocketRealtimeClient client;
  var built = false;
  late List<RealtimeStatus> statuses;
  late List<RealtimeEvent> events;

  WebSocketRealtimeClient build({RealtimeTiming timing = fast}) {
    built = true;
    client = WebSocketRealtimeClient(
      endpoint: endpoint,
      accessToken: tokens.call,
      connector: server.connect,
      timing: timing,
    );
    client.statuses.listen(statuses.add);
    client.events.listen(events.add);
    return client;
  }

  /// Connects and completes the handshake.
  Future<void> live() async {
    await client.connect();
    await eventually(
      () => server.ends.isNotEmpty && server.last.frames.isNotEmpty,
    );
    server.last.ready();
    await eventually(() => client.status.isLive);
  }

  setUp(() {
    server = FakeServer();
    tokens = FakeTokens();
    statuses = [];
    events = [];
  });

  tearDown(() async {
    if (built) await client.dispose();
    built = false;
  });

  test('derives the endpoint from the API address', () {
    expect(
      realtimeEndpoint(Uri.parse('https://api.example.org/')).toString(),
      'wss://api.example.org/realtime',
    );
    expect(
      realtimeEndpoint(Uri.parse('http://localhost:3000/')).toString(),
      'ws://localhost:3000/realtime',
    );
    expect(
      realtimeEndpoint(Uri.parse('https://example.org/api/')).toString(),
      'wss://example.org/api/realtime',
    );
  });

  test(
    'authenticates in the first frame — the token never goes in the URL',
    () async {
      build();
      await live();

      expect(server.urls.single, endpoint);
      expect(server.urls.single.query, isEmpty);
      expect(server.last.frames.first, {'type': 'auth', 'token': 'token-1'});
      expect(statuses, [RealtimeStatus.connecting, RealtimeStatus.connected]);
    },
  );

  test('passes each event on once, and drops what it cannot trust', () async {
    build();
    await live();
    final sent = messageSentJson();

    server.last.send(sent);
    server.last.send(sent); // the same fact again
    server.last.socket.sendText('{not json');
    server.last.socket.sendBytes(Uint8List(3));
    server.last.send({...sent, 'version': 2, 'eventId': 'other'});
    server.last.send(messageSentJson(messageId: 'm-8', sequence: 8));
    await eventually(() => events.length == 2);
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(events.map((e) => e.eventId), [
      'message.sent:m-7',
      'message.sent:m-8',
    ]);
  });

  group('subscribe', () {
    test('matches the answer to the question', () async {
      build();
      await live();

      final confirmed = client.subscribe('c-1');
      await eventually(() => server.last.ofType('subscribe').isNotEmpty);
      final question = server.last.ofType('subscribe').single;
      expect(question['conversationId'], 'c-1');
      server.last.send({
        'type': 'subscribed',
        'conversationId': 'c-1',
        'lastSequence': 12,
        'lastReadSequence': 9,
        'id': question['id'],
      });
      final result = await confirmed;
      expect(result, isA<Subscribed>());
      expect((result as Subscribed).lastSequence, 12);
    });

    test('reports a refusal with its code', () async {
      build();
      await live();

      final refused = client.subscribe('not-mine');
      await eventually(() => server.last.ofType('subscribe').isNotEmpty);
      server.last.send({
        'type': 'error',
        'code': 'CONVERSATION_NOT_FOUND',
        'message': 'No such conversation.',
        'id': server.last.ofType('subscribe').single['id'],
      });
      final result = await refused;
      expect(result, isA<SubscriptionRefused>());
      expect((result as SubscriptionRefused).code.meansNoAccess, isTrue);
    });

    test(
      'is unavailable without a live connection, or without an answer',
      () async {
        build();
        expect(await client.subscribe('c-1'), isA<SubscriptionUnavailable>());
        await live();
        expect(await client.subscribe('c-1'), isA<SubscriptionUnavailable>());
      },
    );
  });

  group('staying connected', () {
    test(
      'reconnects after the connection drops, and says reconnected',
      () async {
        build();
        await live();

        // Any close the client did not ask for (fakes cannot send 1006).
        await server.last.close(1000);
        await eventually(
          () => server.ends.length == 2 && server.last.frames.isNotEmpty,
        );
        expect(client.status, RealtimeStatus.reconnecting);
        server.last.ready();
        await eventually(() => client.status == RealtimeStatus.reconnected);

        expect(statuses, [
          RealtimeStatus.connecting,
          RealtimeStatus.connected,
          RealtimeStatus.reconnecting,
          RealtimeStatus.reconnected,
        ]);
      },
    );

    test(
      'keeps trying, backing off, while the server cannot be reached',
      () async {
        build();
        server.refuseNext = 3;
        await client.connect();
        await eventually(() => server.ends.isNotEmpty);
        server.last.ready();
        await eventually(() => client.status.isLive);

        expect(server.urls, hasLength(4));
        expect(client.status, RealtimeStatus.connected);
      },
    );

    test(
      'renews the token and reconnects when the server says unauthorized',
      () async {
        build();
        await live();

        await server.last.close(RealtimeCloseCodes.unauthorized);
        await eventually(
          () => server.ends.length == 2 && server.last.frames.isNotEmpty,
        );

        expect(tokens.renewals, 1);
        expect(server.last.frames.first, {'type': 'auth', 'token': 'token-2'});
        server.last.ready();
        await eventually(() => client.status == RealtimeStatus.reconnected);
      },
    );

    test('stops, signed out, when the session is over', () async {
      build();
      await live();
      tokens.sessionOver = true;

      await server.last.close(RealtimeCloseCodes.unauthorized);
      await eventually(() => client.status == RealtimeStatus.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 60));

      expect(server.ends, hasLength(1));
    });

    test('stops for good when the account may not use it (4403)', () async {
      build();
      await live();

      await server.last.close(RealtimeCloseCodes.forbidden);
      await eventually(() => client.status == RealtimeStatus.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 60));

      expect(server.ends, hasLength(1));
    });

    test(
      'treats a silent connection as dead, and a talking one as alive',
      () async {
        build(
          timing: const RealtimeTiming(
            heartbeatInterval: Duration(milliseconds: 20),
            pongTimeout: Duration(milliseconds: 40),
            backoffBase: Duration(milliseconds: 5),
            backoffMax: Duration(milliseconds: 20),
            minimumRenewalDelay: Duration(minutes: 1),
          ),
        );
        await live();
        await Future<void>.delayed(const Duration(milliseconds: 150));
        expect(server.ends, hasLength(1)); // it answered every ping
        expect(server.last.ofType('ping'), isNotEmpty);

        server.last.autoPong = false; // the network vanished without a word
        await eventually(() => server.ends.length == 2);
        expect(client.status, RealtimeStatus.reconnecting);
      },
    );

    test(
      're-authenticates on the same connection before the token expires',
      () async {
        build();
        await client.connect();
        await eventually(
          () => server.ends.isNotEmpty && server.last.frames.isNotEmpty,
        );
        server.last.ready(expiresIn: const Duration(milliseconds: 80));
        await eventually(() => client.status.isLive);

        await eventually(() => server.last.ofType('auth').length == 2);
        expect(server.last.ofType('auth').last, {
          'type': 'auth',
          'token': 'token-2',
        });
        server.last.ready();
        await Future<void>.delayed(const Duration(milliseconds: 20));
        expect(server.ends, hasLength(1));
        expect(statuses, [RealtimeStatus.connecting, RealtimeStatus.connected]);
      },
    );

    test('opens a fresh connection at once on reconnect()', () async {
      build();
      await live();

      await client.reconnect();
      await eventually(
        () => server.ends.length == 2 && server.last.frames.isNotEmpty,
      );
      server.last.ready();
      await eventually(() => client.status == RealtimeStatus.reconnected);
      expect(server.ends.first.closed, isNotNull);
    });

    test('disconnects cleanly and stays disconnected', () async {
      build();
      await live();

      await client.disconnect();
      await eventually(() => server.last.closed != null);
      await Future<void>.delayed(const Duration(milliseconds: 60));

      expect(server.last.closed!.code, 1000);
      expect(server.ends, hasLength(1));
      expect(client.status, RealtimeStatus.disconnected);
    });
  });
}
