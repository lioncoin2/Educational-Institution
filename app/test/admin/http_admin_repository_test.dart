import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/admin.dart';
import 'package:quran_institution_app/data/models/auth.dart' show AccountStatus;
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/http/http_admin_repository.dart';

/// A `UserAccountResponse` exactly as backend identity/api/responses.ts writes
/// it (identifiers is an array; roles carry code/grantedAt/grantedBy).
Map<String, Object?> accountJson({
  String id = 'u-1',
  String displayName = 'الأستاذة مريم',
  String status = 'PENDING',
  String email = 'maryam@example.edu',
  List<String> roles = const [],
}) => {
  'id': id,
  'displayName': displayName,
  'status': status,
  'identifiers': [
    {'type': 'email', 'value': email},
  ],
  'roles': [
    for (final r in roles)
      {'code': r, 'grantedAt': '2026-09-01T08:00:00.000Z', 'grantedBy': null},
  ],
  'createdAt': '2026-09-01T08:00:00.000Z',
  'updatedAt': '2026-09-01T08:00:00.000Z',
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

  (http.Client, List<http.Request>) recording(int status, Object body) {
    final seen = <http.Request>[];
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

  Matcher refusedWith(String code) =>
      throwsA(isA<AdminException>().having((e) => e.code, 'code', code));

  group('HttpAdminRepository.accounts', () {
    test(
      'GETs /admin/users, decodes items + nextCursor, records origin',
      () async {
        final repo = HttpAdminRepository(
          await api(
            serving(200, {
              'items': [
                accountJson(id: 'u-1'),
                accountJson(id: 'u-2', status: 'ACTIVE', roles: ['TEACHER']),
              ],
              'nextCursor': 'next',
            }),
          ),
        );
        final page = await repo.accounts();
        expect(page.items.map((a) => a.id), ['u-1', 'u-2']);
        expect(page.items.first.primaryIdentifier, 'maryam@example.edu');
        expect(page.items.first.status, AccountStatus.pending);
        expect(page.items.first.origin, DataOrigin.records);
        expect(page.items[1].roles, ['TEACHER']);
        expect(page.nextCursor, 'next');
      },
    );

    test('passes the cursor', () async {
      final (client, seen) = recording(200, {
        'items': <Object?>[],
        'nextCursor': null,
      });
      final repo = HttpAdminRepository(await api(client));
      await repo.accounts(cursor: 'c2');
      expect(seen.single.url.path, '/admin/users');
      expect(seen.single.url.queryParameters['cursor'], 'c2');
    });
  });

  group('HttpAdminRepository.createAccount', () {
    test('POSTs /admin/users with the fields, returns the account', () async {
      final (client, seen) = recording(
        201,
        accountJson(
          id: 'u-9',
          displayName: 'حساب جديد',
          email: 'new@example.edu',
        ),
      );
      final repo = HttpAdminRepository(await api(client));
      final account = await repo.createAccount(
        displayName: 'حساب جديد',
        identifier: 'new@example.edu',
        initialPassword: 'password123',
      );
      expect(account.id, 'u-9');
      expect(account.status, AccountStatus.pending);
      expect(account.origin, DataOrigin.records);
      expect(seen.single.method, 'POST');
      expect(seen.single.url.path, '/admin/users');
      expect(jsonDecode(seen.single.body), {
        'displayName': 'حساب جديد',
        'identifierType': 'email',
        'identifier': 'new@example.edu',
        'initialPassword': 'password123',
      });
      expect(seen.single.headers['authorization'], 'Bearer a1');
    });

    test('maps a taken identifier (409) to its code', () async {
      final repo = HttpAdminRepository(
        await api(
          serving(409, {
            'error': {
              'kind': 'conflict',
              'code': 'identity.identifier_taken',
              'message': 'taken',
            },
            'requestId': 'r',
          }),
        ),
      );
      await expectLater(
        repo.createAccount(
          displayName: 'x',
          identifier: 'a@b.co',
          initialPassword: 'password123',
        ),
        refusedWith('identity.identifier_taken'),
      );
    });

    test('maps a short password (422) to its code', () async {
      final repo = HttpAdminRepository(
        await api(
          serving(422, {
            'error': {
              'kind': 'validation',
              'code': 'identity.password_too_short',
              'message': 'short',
            },
            'requestId': 'r',
          }),
        ),
      );
      await expectLater(
        repo.createAccount(
          displayName: 'x',
          identifier: 'a@b.co',
          initialPassword: 'short',
        ),
        refusedWith('identity.password_too_short'),
      );
    });
  });
}
