import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/admin.dart';
import 'package:quran_institution_app/data/models/auth.dart' show AccountStatus;
import 'package:quran_institution_app/data/repositories/http/http_admin_repository.dart';

/// Account-lifecycle administration on the wire: method, path (ids escaped),
/// body, and the row parsed back. Role and status writes return the fresh
/// account; the password is sent once (204, nothing back); session revocation
/// returns only a count. A refusal keeps the server's code. The server
/// re-authorises and enforces self/outrank/transition rules — this only checks
/// the request formed and the answer read.
void main() {
  late InMemoryTokenStore tokens;
  final recorded = <http.Request>[];

  HttpAdminRepository over(http.Response Function(http.Request) handler) {
    final client = MockClient((request) async {
      recorded.add(request);
      return handler(request);
    });
    return HttpAdminRepository(
      ApiClient(
        baseUri: Uri.parse('https://api.test/'),
        httpClient: client,
        tokenStore: tokens,
      ),
    );
  }

  setUp(() async {
    recorded.clear();
    tokens = InMemoryTokenStore();
    await tokens.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
  });

  http.Response ok(Object body) => http.Response(
    jsonEncode(body),
    200,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
  http.Response fail(int status, String code) => http.Response(
    jsonEncode({
      'error': {'kind': 'x', 'code': code, 'message': code},
    }),
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );

  Map<String, Object?> accountRow({
    String id = 'u:1',
    String status = 'ACTIVE',
    List<String> roles = const ['TEACHER'],
  }) => {
    'id': id,
    'displayName': 'الأستاذة مريم',
    'status': status,
    'identifiers': [
      {'type': 'email', 'value': 'maryam@example.edu'},
    ],
    'roles': [
      for (final r in roles)
        {'code': r, 'grantedAt': '2026-09-01T08:00:00.000Z', 'grantedBy': null},
    ],
    'createdAt': '2026-09-01T08:00:00.000Z',
    'updatedAt': '2026-09-02T08:00:00.000Z',
  };

  http.Request req() => recorded.single;
  Map<String, Object?> sentBody() =>
      (jsonDecode(req().body) as Map).cast<String, Object?>();
  String reqPath() => Uri.decodeComponent(req().url.path);

  test('reads one account — GET /admin/users/:id, escaped, parsed', () async {
    final repo = over((_) => ok(accountRow(id: 'u:1', roles: ['TEACHER'])));
    final account = await repo.account('u:1');
    expect(req().method, 'GET');
    expect(reqPath(), '/admin/users/u:1');
    expect(account.displayName, 'الأستاذة مريم');
    expect(account.roles, ['TEACHER']);
    expect(account.status, AccountStatus.active);
    // The projection the admin sees — no password anywhere in the model.
    expect(account.primaryIdentifier, 'maryam@example.edu');
  });

  test(
    'assigns a role — POST …/roles {role}, returns the fresh account',
    () async {
      final repo = over(
        (_) => ok(accountRow(roles: ['TEACHER', 'SUPERVISOR'])),
      );
      final account = await repo.assignRole('u:1', role: 'SUPERVISOR');
      expect(req().method, 'POST');
      expect(reqPath(), '/admin/users/u:1/roles');
      expect(sentBody(), {'role': 'SUPERVISOR'});
      expect(account.roles, contains('SUPERVISOR'));
    },
  );

  test(
    'removes a role — DELETE …/roles/:role, returns the fresh account',
    () async {
      final repo = over((_) => ok(accountRow(roles: ['TEACHER'])));
      final account = await repo.removeRole('u:1', role: 'SUPERVISOR');
      expect(req().method, 'DELETE');
      expect(reqPath(), '/admin/users/u:1/roles/SUPERVISOR');
      expect(account.roles, isNot(contains('SUPERVISOR')));
    },
  );

  test(
    'changes status — POST …/status {status wire}, returns account',
    () async {
      final repo = over((_) => ok(accountRow(status: 'SUSPENDED')));
      final account = await repo.setStatus(
        'u:1',
        status: AccountStatus.suspended,
      );
      expect(req().method, 'POST');
      expect(reqPath(), '/admin/users/u:1/status');
      expect(sentBody(), {'status': 'SUSPENDED'});
      expect(account.status, AccountStatus.suspended);
    },
  );

  test(
    'sets a password — POST …/password {newPassword}, 204, nothing back',
    () async {
      final repo = over((_) => http.Response('', 204));
      await repo.resetPassword('u:1', newPassword: 'a-strong-secret');
      expect(req().method, 'POST');
      expect(reqPath(), '/admin/users/u:1/password');
      expect(sentBody(), {'newPassword': 'a-strong-secret'});
    },
  );

  test('revokes sessions — DELETE …/sessions, returns the count', () async {
    final repo = over((_) => ok({'sessionsEnded': 3}));
    final count = await repo.revokeSessions('u:1');
    expect(req().method, 'DELETE');
    expect(reqPath(), '/admin/users/u:1/sessions');
    expect(count, 3);
  });

  group('a refusal keeps its code and changes nothing', () {
    test('a role above the caller', () async {
      final repo = over((_) => fail(403, 'identity.role_outranks_actor'));
      await expectLater(
        repo.assignRole('u:1', role: 'OWNER'),
        throwsA(
          isA<AdminException>().having(
            (e) => e.code,
            'code',
            'identity.role_outranks_actor',
          ),
        ),
      );
    });

    test('an invalid status transition', () async {
      final repo = over((_) => fail(409, 'identity.status_transition_invalid'));
      await expectLater(
        repo.setStatus('u:1', status: AccountStatus.pending),
        throwsA(
          isA<AdminException>().having(
            (e) => e.code,
            'code',
            'identity.status_transition_invalid',
          ),
        ),
      );
    });

    test('administering your own account', () async {
      final repo = over((_) => fail(403, 'identity.self_administration'));
      await expectLater(
        repo.revokeSessions('me'),
        throwsA(
          isA<AdminException>().having(
            (e) => e.code,
            'code',
            'identity.self_administration',
          ),
        ),
      );
    });
  });
}
