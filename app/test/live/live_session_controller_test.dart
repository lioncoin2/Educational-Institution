import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_live_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/state/live_session_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

class _FakeLive implements LiveRepository {
  _FakeLive(this._answer);

  final Future<LiveSession?> Function(String communityId) _answer;
  int calls = 0;

  @override
  Future<LiveSession?> currentSession(String communityId) {
    calls += 1;
    return _answer(communityId);
  }
}

LiveSession _session(String communityId) => LiveSession(
  id: 's-$communityId',
  communityId: communityId,
  state: LiveSessionState.live,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 1,
  me: const LiveMe(role: LiveParticipantRole.listener),
);

void main() {
  ProviderContainer boot(LiveRepository repo) {
    final container = ProviderContainer(
      overrides: [
        liveRepositoryProvider.overrideWithValue(repo),
        sessionUserProvider.overrideWith((ref) async => null),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  Future<LiveSession?> load(ProviderContainer c, String id) {
    final keepAlive = c.listen(liveSessionProvider(id), (_, _) {});
    addTearDown(keepAlive.close);
    return c.read(liveSessionProvider(id).future);
  }

  group('LiveSessionController', () {
    test('loads the community’s running session', () async {
      final repo = _FakeLive((id) async => _session(id));
      final session = await load(boot(repo), 'c-1');
      expect(session, isNotNull);
      expect(session!.communityId, 'c-1');
      expect(session.isLive, isTrue);
    });

    test('is "no active session" (null) when none is running', () async {
      expect(await load(boot(_FakeLive((_) async => null)), 'c-1'), isNull);
    });

    test('surfaces a refusal as an error', () async {
      final container = boot(
        _FakeLive((_) async => throw const LiveException('unavailable', 'no')),
      );
      final keepAlive = container.listen(liveSessionProvider('c-1'), (_, _) {});
      addTearDown(keepAlive.close);
      await expectLater(
        container.read(liveSessionProvider('c-1').future),
        throwsA(isA<LiveException>()),
      );
      expect(container.read(liveSessionProvider('c-1')).hasError, isTrue);
    });

    test('refresh reads the current session again', () async {
      final repo = _FakeLive((id) async => _session(id));
      final container = boot(repo);
      await load(container, 'c-1');
      expect(repo.calls, 1);
      await container.read(liveSessionProvider('c-1').notifier).refresh();
      expect(repo.calls, 2);
    });
  });

  group('MockLiveRepository', () {
    test('answers a demo session for a live community, flagged mock', () async {
      final repo = MockLiveRepository(latency: Duration.zero);
      final session = await repo.currentSession('mock-community-live');
      expect(session, isNotNull);
      expect(session!.isLive, isTrue);
      expect(session.origin, DataOrigin.mock);
    });

    test('answers null for a community with no running session', () async {
      final repo = MockLiveRepository(latency: Duration.zero);
      expect(await repo.currentSession('a-quiet-community'), isNull);
    });
  });
}
