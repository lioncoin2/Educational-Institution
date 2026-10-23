import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/repositories/empty_repositories.dart';
import 'package:quran_institution_app/data/repositories/http/http_academic_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_community_repository.dart';
import 'package:quran_institution_app/data/repositories/http/http_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_academic_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_repositories.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Guards the Trial regression: a connected (backend-mode) build MUST resolve to
/// the HTTP repositories and MUST NOT serve demo mock data — including the two
/// always-mock seams (certificates, announcements), which must be empty (an
/// honest "no records"), never the invented demo set. The demo (in-memory)
/// build still uses the mocks.
void main() {
  ProviderContainer backend() => ProviderContainer(
    overrides: [
      backendModeProvider.overrideWithValue(true),
      httpClientProvider.overrideWithValue(
        MockClient((_) async => http.Response('{}', 200)),
      ),
      tokenStoreProvider.overrideWithValue(InMemoryTokenStore()),
    ],
  );

  ProviderContainer demo() => ProviderContainer(
    overrides: [backendModeProvider.overrideWithValue(false)],
  );

  group('backend (server / Trial) mode', () {
    test('core repositories are HTTP-backed', () {
      final c = backend();
      addTearDown(c.dispose);
      expect(c.read(academicRepositoryProvider), isA<HttpAcademicRepository>());
      expect(
        c.read(communityRepositoryProvider),
        isA<HttpCommunityRepository>(),
      );
      expect(
        c.read(messagingRepositoryProvider),
        isA<HttpMessagingRepository>(),
      );
    });

    test('no repository is a demo mock', () {
      final c = backend();
      addTearDown(c.dispose);
      expect(
        c.read(academicRepositoryProvider),
        isNot(isA<MockAcademicRepository>()),
      );
      expect(
        c.read(communityRepositoryProvider),
        isNot(isA<MockCommunityRepository>()),
      );
      expect(
        c.read(messagingRepositoryProvider),
        isNot(isA<MockMessagingRepository>()),
      );
    });

    test('certificates & announcements are empty, never mock', () {
      final c = backend();
      addTearDown(c.dispose);
      expect(
        c.read(certificateRepositoryProvider),
        isA<EmptyCertificateRepository>(),
      );
      expect(c.read(feedRepositoryProvider), isA<EmptyFeedRepository>());
      expect(
        c.read(certificateRepositoryProvider),
        isNot(isA<MockCertificateRepository>()),
      );
      expect(c.read(feedRepositoryProvider), isNot(isA<MockFeedRepository>()));
    });
  });

  group('demo (in-memory) mode', () {
    test('repositories are the demo mocks', () {
      final c = demo();
      addTearDown(c.dispose);
      expect(c.read(academicRepositoryProvider), isA<MockAcademicRepository>());
      expect(
        c.read(communityRepositoryProvider),
        isA<MockCommunityRepository>(),
      );
      expect(
        c.read(certificateRepositoryProvider),
        isA<MockCertificateRepository>(),
      );
      expect(c.read(feedRepositoryProvider), isA<MockFeedRepository>());
    });
  });

  group('empty server-mode repositories return no data (never invented)', () {
    test('EmptyFeedRepository.getAnnouncements() is empty', () async {
      expect(await const EmptyFeedRepository().getAnnouncements(), isEmpty);
    });
    test('EmptyCertificateRepository returns none', () async {
      expect(
        await const EmptyCertificateRepository().getCertificates(),
        isEmpty,
      );
      expect(
        await const EmptyCertificateRepository().getCertificate('x'),
        isNull,
      );
    });
  });
}
