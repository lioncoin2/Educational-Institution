import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/http/http_academic_repository.dart';

import 'academic_test_support.dart';

void main() {
  late AcademicServer server;
  late InMemoryTokenStore tokens;
  late HttpAcademicRepository repository;

  HttpAcademicRepository over(http.Client client) => HttpAcademicRepository(
    ApiClient(
      baseUri: Uri.parse('https://api.test/'),
      httpClient: client,
      tokenStore: tokens,
    ),
  );

  setUp(() async {
    server = AcademicServer();
    tokens = InMemoryTokenStore();
    await tokens.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
    repository = over(server.client);
  });

  test(
    'reads the catalogue from /academic/sections, with the bearer token',
    () async {
      final catalogue = await repository.catalogue();
      expect(catalogue, hasLength(9));
      expect(catalogue.first.code, 'dep-literacy');
      expect(catalogue.first.id, 's:dep-literacy');
      expect(server.calls, ['GET /academic/sections']);
      expect(server.requests.single.headers['authorization'], 'Bearer a1');
      expect(repository.origin, DataOrigin.records);
    },
  );

  test('reads a program and a halaqa by the server’s id, escaped', () async {
    final program = await repository.program('p:dep-letters-program');
    expect(program!.halaqat, hasLength(10));
    expect(program.section.code, 'dep-letters');
    final halaqa = await repository.halaqa('h:dep-letters-h4');
    expect(halaqa!.halaqa.name, 'الحلقة 4');
    expect(halaqa.section.kind, SectionKind.progressive);
    expect(
      server.requests.last.url.path,
      '/academic/halaqat/h%3Adep-letters-h4',
    );
  });

  test(
    'answers null for no such program or halaqa — and only for that',
    () async {
      expect(await repository.program('nope'), isNull);
      expect(await repository.halaqa('nope'), isNull);

      server.refuse['GET /academic/halaqat/h:dep-letters-h4'] = () =>
          refusal(404, 'not_found');
      await expectLater(
        repository.halaqa('h:dep-letters-h4'),
        throwsA(
          isA<AcademicException>().having((e) => e.code, 'code', 'not_found'),
        ),
      );
    },
  );

  test('reads my record from /academic/me', () async {
    server.enroll(
      'h:dep-tajweed-2-h3',
      teachers: [
        {'userId': 't1', 'displayName': 'الأستاذة عائشة', 'role': 'TEACHER'},
      ],
    );
    final mine = await repository.me();
    expect(
      mine.activeEnrollments.single.placement.halaqa.code,
      'dep-tajweed-2-h3',
    );
    expect(
      mine.activeEnrollments.single.teachers.single.displayName,
      'الأستاذة عائشة',
    );
  });

  test('turns a refusal into its code — sign-in, access, anything', () async {
    server.refuse['GET /academic/me'] = () =>
        refusal(403, 'identity.permission_denied');
    await expectLater(
      repository.me(),
      throwsA(
        isA<AcademicException>().having(
          (e) => e.code,
          'code',
          'identity.permission_denied',
        ),
      ),
    );

    await tokens.clear();
    await expectLater(
      repository.catalogue(),
      throwsA(
        isA<AcademicException>().having(
          (e) => e.needsSignIn,
          'sign-in',
          isTrue,
        ),
      ),
    );
  });

  test(
    'says so when the server cannot be reached, or sends something unreadable',
    () async {
      final offline = over(
        MockClient((_) async => throw const SocketLikeException()),
      );
      await expectLater(
        offline.catalogue(),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.isNetwork,
            'network',
            isTrue,
          ),
        ),
      );
      final garbled = over(
        MockClient((_) async => jsonResponse(200, {'program': 'x'})),
      );
      await expectLater(
        garbled.program('p1'),
        throwsA(
          isA<AcademicException>().having(
            (e) => e.code,
            'code',
            'academic.unreadable',
          ),
        ),
      );
    },
  );

  test(
    'offers nothing that writes: enrolment and assignment are staff acts',
    () async {
      await repository.catalogue();
      await repository.program('p:dep-literacy-program');
      await repository.halaqa('h:dep-literacy-h1');
      await repository.me();
      expect(server.requests.every((r) => r.method == 'GET'), isTrue);
    },
  );
}

class SocketLikeException implements Exception {
  const SocketLikeException();
}
