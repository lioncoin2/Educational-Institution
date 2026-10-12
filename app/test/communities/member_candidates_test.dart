import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/people.dart';
import 'package:quran_institution_app/data/repositories/http/http_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';

/// The community-scoped member-candidate search (Sprint 24, Design X): the
/// add-member picker hits `GET /communities/:id/member-candidates`, NOT the
/// institution-wide `GET /people`, and the id in the path is the community's.
http.Response json(int status, Object body) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

void main() {
  final base = Uri.parse('https://api.example.org/');

  Future<ApiClient> api(MockClient client) async {
    final store = InMemoryTokenStore();
    await store.write(const Tokens(accessToken: 'a', refreshToken: 'r'));
    return ApiClient(baseUri: base, httpClient: client, tokenStore: store);
  }

  group('HttpCommunityRepository.memberCandidates', () {
    test('searches the community-scoped route with the community id and prefix', () async {
      final client = MockClient((request) async {
        expect(request.method, 'GET');
        // The community-scoped route — never /people.
        expect(request.url.path, '/communities/c-1/member-candidates');
        expect(request.url.queryParameters['q'], 'سا');
        return json(200, {
          'items': [
            {'userId': 'u-1', 'displayName': 'سارة'},
            {'userId': 'u-2', 'displayName': 'سامي'},
          ],
          'nextCursor': 'c1',
        });
      });
      final page = await HttpCommunityRepository(await api(client)).memberCandidates('c-1', 'سا');
      expect(page.items.map((p) => p.userId), ['u-1', 'u-2']);
      expect(page.items.first.displayName, 'سارة');
      expect(page.nextCursor, 'c1');
    });

    test('forwards an opaque cursor when given one', () async {
      final client = MockClient((request) async {
        expect(request.url.path, '/communities/c-1/member-candidates');
        expect(request.url.queryParameters['cursor'], 'abc');
        return json(200, {'items': <Object?>[], 'nextCursor': null});
      });
      await HttpCommunityRepository(await api(client)).memberCandidates('c-1', 'سا', cursor: 'abc');
    });

    test('maps a 403 to PeopleException.isForbidden (no invite authority here)', () async {
      final client = MockClient(
        (_) async => json(403, {
          'error': {'kind': 'forbidden', 'code': 'identity.permission_denied', 'message': 'no'},
        }),
      );
      await expectLater(
        HttpCommunityRepository(await api(client)).memberCandidates('c-1', 'سا'),
        throwsA(isA<PeopleException>().having((e) => e.isForbidden, 'isForbidden', isTrue)),
      );
    });
  });

  group('MockCommunityRepository.memberCandidates', () {
    test('filters by case-insensitive prefix; a blank query is an empty page', () async {
      final repo = MockCommunityRepository(latency: Duration.zero);
      expect((await repo.memberCandidates('c', '')).items, isEmpty);
      final page = await repo.memberCandidates('c', 'سا');
      expect(page.items, isNotEmpty);
      expect(page.items.every((p) => (p.displayName ?? '').startsWith('سا')), isTrue);
      expect(page.items.map((p) => p.userId), contains('mock-person-sara'));
    });

    test('a second page (a spent cursor) is empty', () async {
      final repo = MockCommunityRepository(latency: Duration.zero);
      expect((await repo.memberCandidates('c', 'سا', cursor: 'c1')).items, isEmpty);
    });
  });
}
