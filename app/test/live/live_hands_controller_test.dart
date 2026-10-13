import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/state/live_hands_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// A repository that answers the hands read a page at a time (keyed by the
/// cursor it is asked for) and records how it was queried. Every other method
/// throws — the hands controller must only read hands.
class _HandsRepo implements LiveRepository {
  _HandsRepo(this._pages);

  final Map<String?, LiveHandsPage> _pages;
  Object? error;
  final List<String> calls = [];

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async {
    calls.add('${state?.wire}:$cursor');
    if (error != null) throw error!;
    return _pages[cursor] ??
        const LiveHandsPage(items: [], nextCursor: null, origin: DataOrigin.mock);
  }

  @override
  Future<LiveSession?> currentSession(String communityId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> start(String communityId) => throw UnimplementedError();

  @override
  Future<LiveSession> getSession(String sessionId) => throw UnimplementedError();
  @override
  Future<LiveSession> endSession(String sessionId) => throw UnimplementedError();
  @override
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  }) => throw UnimplementedError();
  @override
  Future<bool> resetRoom(String sessionId) => throw UnimplementedError();
  @override
  Future<LiveSession> claimPresenter(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> stopPresenter(String sessionId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> grantPresenter(String sessionId, String userId) =>
      throw UnimplementedError();
  @override
  Future<LiveSession> revokePresenter(String sessionId, String userId) =>
      throw UnimplementedError();
  @override
  Future<LiveMediaGrant> join(String sessionId) => throw UnimplementedError();
}

LiveHand _hand(String id, String userId) => LiveHand(
  id: id,
  sessionId: 's-1',
  userId: userId,
  state: SpeakerRequestState.pending,
  requestedAt: DateTime.utc(2026),
);

LiveHandsPage _page(List<LiveHand> items, {String? next}) =>
    LiveHandsPage(items: items, nextCursor: next, origin: DataOrigin.records);

void main() {
  ProviderContainer containerWith(_HandsRepo repo) {
    final container = ProviderContainer(
      overrides: [
        liveRepositoryProvider.overrideWithValue(repo),
        sessionUserProvider.overrideWith((ref) async => null),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  const query = (sessionId: 's-1', state: null) as LiveHandsQuery;

  Future<LiveHandsState> firstPage(
    ProviderContainer container,
    LiveHandsQuery q,
  ) async {
    // Keep the autoDispose family member alive for the test.
    final sub = container.listen(liveHandsProvider(q), (_, _) {});
    addTearDown(sub.close);
    return container.read(liveHandsProvider(q).future);
  }

  test('loads the first page', () async {
    final repo = _HandsRepo({
      null: _page([_hand('h1', 'u-1'), _hand('h2', 'u-2')], next: 'c1'),
    });
    final container = containerWith(repo);

    final state = await firstPage(container, query);
    expect(state.items.map((h) => h.id), ['h1', 'h2']);
    expect(state.hasMore, isTrue);
    expect(repo.calls, ['null:null']);
  });

  test('loadMore appends the next page, deduped by request id', () async {
    final repo = _HandsRepo({
      null: _page([_hand('h1', 'u-1'), _hand('h2', 'u-2')], next: 'c1'),
      'c1': _page([_hand('h2', 'u-2'), _hand('h3', 'u-3')]), // h2 repeats
    });
    final container = containerWith(repo);
    await firstPage(container, query);

    await container.read(liveHandsProvider(query).notifier).loadMore();
    final state = container.read(liveHandsProvider(query)).value!;
    expect(state.items.map((h) => h.id), ['h1', 'h2', 'h3']);
    expect(state.hasMore, isFalse);
    expect(repo.calls, ['null:null', 'null:c1']);
  });

  test('loadMore failure keeps what is shown and flags a retry', () async {
    final repo = _HandsRepo({
      null: _page([_hand('h1', 'u-1')], next: 'c1'),
    });
    final container = containerWith(repo);
    await firstPage(container, query);

    repo.error = const LiveException('unavailable', 'x');
    await container.read(liveHandsProvider(query).notifier).loadMore();
    final state = container.read(liveHandsProvider(query)).value!;
    expect(state.items.map((h) => h.id), ['h1']); // unchanged
    expect(state.loadMoreFailed, isTrue);
    expect(state.loadingMore, isFalse);
  });

  test('forwards the filter state to the repository', () async {
    final repo = _HandsRepo({null: _page([_hand('h1', 'u-1')])});
    final container = containerWith(repo);
    const granted = (sessionId: 's-1', state: LiveHandsFilter.granted)
        as LiveHandsQuery;

    await firstPage(container, granted);
    expect(repo.calls, ['granted:null']);
  });

  test('refresh re-reads from the first page', () async {
    final repo = _HandsRepo({null: _page([_hand('h1', 'u-1')])});
    final container = containerWith(repo);
    await firstPage(container, query);
    expect(repo.calls.length, 1);

    await container.read(liveHandsProvider(query).notifier).refresh();
    expect(repo.calls.length, 2);
  });
}
