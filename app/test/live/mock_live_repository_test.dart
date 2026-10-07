import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_live_repository.dart';

/// The demo `/live` store: invented, flagged [DataOrigin.mock], and shaped
/// like the server — a session fetched by id, and a finite, deterministic
/// hand queue that depends on the filter and runs out after one page.
void main() {
  // A fixed "now" so the invented timestamps are deterministic.
  final now = DateTime.utc(2026, 1, 1, 12);
  MockLiveRepository repo() =>
      MockLiveRepository(latency: Duration.zero, clock: () => now);

  group('MockLiveRepository.getSession', () {
    test(
      'returns a live, mock-flagged session carrying the asked id',
      () async {
        final session = await repo().getSession('sess-42');
        expect(session.id, 'sess-42');
        expect(session.isLive, isTrue);
        expect(session.origin, DataOrigin.mock);
        expect(session.startedAt.isBefore(now), isTrue);
      },
    );

    test('is deterministic under a fixed clock', () async {
      final a = await repo().getSession('sess-42');
      final b = await repo().getSession('sess-42');
      expect(a.id, b.id);
      expect(a.startedAt, b.startedAt);
      expect(a.state, b.state);
    });
  });

  group('MockLiveRepository.hands', () {
    test('a first page defaults to one pending hand, mock-flagged', () async {
      final page = await repo().hands('sess-42');
      expect(page.origin, DataOrigin.mock);
      expect(page.items, hasLength(1));
      final hand = page.items.single;
      expect(hand.sessionId, 'sess-42');
      expect(hand.state, SpeakerRequestState.pending);
      expect(hand.media, isNull); // pending: nothing observed yet
      expect(page.nextCursor, isNull); // one finite page
    });

    test(
      'the granted filter yields a granted hand with observed media',
      () async {
        final page = await repo().hands(
          'sess-42',
          state: LiveHandsFilter.granted,
        );
        expect(page.items, hasLength(1));
        final hand = page.items.single;
        expect(hand.state, SpeakerRequestState.granted);
        expect(hand.grantedAt, isNotNull);
        expect(hand.media, LiveObservedMedia.connected);
        expect(page.nextCursor, isNull);
      },
    );

    test('a cursor past the first page is empty, still mock-flagged', () async {
      final page = await repo().hands('sess-42', cursor: 'anything');
      expect(page.items, isEmpty);
      expect(page.nextCursor, isNull);
      expect(page.origin, DataOrigin.mock);
    });
  });

  group('MockLiveRepository.currentSession (unchanged)', () {
    test('answers for a community running a demo session', () async {
      final session = await repo().currentSession('mock-community-live');
      expect(session, isNotNull);
      expect(session!.isLive, isTrue);
      expect(session.origin, DataOrigin.mock);
    });

    test('answers null for a community with none running', () async {
      expect(await repo().currentSession('some-quiet-community'), isNull);
    });
  });
}
