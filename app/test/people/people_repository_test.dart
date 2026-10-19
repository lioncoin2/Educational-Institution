import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/people.dart';
import 'package:quran_institution_app/data/repositories/http/http_people_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_people_repository.dart';

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

  group('HttpPeopleRepository', () {
    test('searches /people by prefix and parses the minimal projection', () async {
      final client = MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/people');
        expect(request.url.queryParameters['q'], 'سا');
        return json(200, {
          'items': [
            {'userId': 'u-1', 'displayName': 'سارة'},
            {'userId': 'u-2', 'displayName': 'سامي'},
          ],
          'nextCursor': 'c1',
        });
      });
      final page = await HttpPeopleRepository(await api(client)).search('سا');
      expect(page.items.map((p) => p.userId), ['u-1', 'u-2']);
      expect(page.items.first.displayName, 'سارة');
      expect(page.nextCursor, 'c1');
    });

    test('forwards an opaque cursor when given one', () async {
      final client = MockClient((request) async {
        expect(request.url.queryParameters['cursor'], 'abc');
        return json(200, {'items': <Object?>[], 'nextCursor': null});
      });
      await HttpPeopleRepository(await api(client)).search('سا', cursor: 'abc');
    });

    test('maps a 403 to PeopleException.isForbidden (a caller without people.read)', () async {
      final client = MockClient(
        (_) async => json(403, {
          'error': {'kind': 'forbidden', 'code': 'identity.permission_denied', 'message': 'no'},
        }),
      );
      await expectLater(
        HttpPeopleRepository(await api(client)).search('سا'),
        throwsA(isA<PeopleException>().having((e) => e.isForbidden, 'isForbidden', isTrue)),
      );
    });

    test('searches the teacher directory at /people/teachers (Q6)', () async {
      final client = MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/people/teachers');
        expect(request.url.queryParameters['q'], 'عب');
        return json(200, {
          'items': [
            {'userId': 't-1', 'displayName': 'الأستاذ عبدالله'},
          ],
          'nextCursor': null,
        });
      });
      final page = await HttpPeopleRepository(await api(client)).searchTeachers('عب');
      expect(page.items.map((p) => p.userId), ['t-1']);
    });

    test('parses the picture reference: an id for one who has it, null otherwise', () async {
      final client = MockClient(
        (_) async => json(200, {
          'items': [
            {'userId': 'u-1', 'displayName': 'سارة', 'avatarFileAssetId': 'asset-1'},
            {'userId': 'u-2', 'displayName': 'سامي', 'avatarFileAssetId': null},
          ],
          'nextCursor': null,
        }),
      );
      final page = await HttpPeopleRepository(await api(client)).search('سا');
      expect(page.items[0].avatarFileAssetId, 'asset-1');
      expect(page.items[0].hasAvatar, isTrue);
      expect(page.items[1].avatarFileAssetId, isNull);
      expect(page.items[1].hasAvatar, isFalse);
    });

    test('personAvatarUrl reads /people/:id/avatar and returns the short-lived link', () async {
      final client = MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/people/u-1/avatar');
        return json(200, {'url': 'https://cdn.example.org/a/u-1.png?sig=x', 'expiresAt': 'soon'});
      });
      final url = await HttpPeopleRepository(await api(client)).personAvatarUrl('u-1');
      expect(url.toString(), 'https://cdn.example.org/a/u-1.png?sig=x');
    });

    test('personAvatarUrl maps a 404 to PeopleException (no picture → initials)', () async {
      final client = MockClient(
        (_) async => json(404, {
          'error': {
            'kind': 'not_found',
            'code': 'people.person_avatar_not_found',
            'message': 'none',
          },
        }),
      );
      await expectLater(
        HttpPeopleRepository(await api(client)).personAvatarUrl('u-9'),
        throwsA(
          isA<PeopleException>().having((e) => e.code, 'code', 'people.person_avatar_not_found'),
        ),
      );
    });
  });

  group('MockPeopleRepository', () {
    test('filters by case-insensitive prefix; a blank query is an empty page', () async {
      final repo = MockPeopleRepository(latency: Duration.zero);
      expect((await repo.search('')).items, isEmpty);
      final page = await repo.search('سا');
      expect(page.items, isNotEmpty);
      expect(
        page.items.every((p) => (p.displayName ?? '').startsWith('سا')),
        isTrue,
      );
    });

    test('a second page (a spent cursor) is empty', () async {
      final repo = MockPeopleRepository(latency: Duration.zero);
      expect((await repo.search('سا', cursor: 'c1')).items, isEmpty);
    });

    test('searchTeachers returns only teachers — a matching peer is excluded', () async {
      final repo = MockPeopleRepository(latency: Duration.zero);
      final teachers = await repo.searchTeachers('الأ');
      expect(teachers.items.map((p) => p.userId), ['mock-teacher']);
      // أحمد (a peer) surfaces in the general search but never as a teacher.
      expect((await repo.search('أح')).items, isNotEmpty);
      expect((await repo.searchTeachers('أح')).items, isEmpty);
    });

    test('personAvatarUrl returns a link for a person with a picture, else 404', () async {
      final repo = MockPeopleRepository(latency: Duration.zero);
      final link = await repo.personAvatarUrl('mock-person-sara');
      expect(link.toString(), contains('mock-person-sara'));
      await expectLater(
        repo.personAvatarUrl('mock-peer-1'), // no picture
        throwsA(
          isA<PeopleException>().having((e) => e.code, 'code', 'people.person_avatar_not_found'),
        ),
      );
    });

    test('a search result carries the demo picture reference where one is set', () async {
      final repo = MockPeopleRepository(latency: Duration.zero);
      final sara = (await repo.search('سا')).items.firstWhere((p) => p.userId == 'mock-person-sara');
      expect(sara.hasAvatar, isTrue);
    });
  });
}
