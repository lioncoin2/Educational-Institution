import '../../../app/app_config.dart';
import '../../models/data_origin.dart';
import '../../models/live.dart';
import '../repositories.dart';

/// In-memory stand-in for `/live`, for the demo build and widget tests.
///
/// It keeps the server's shape: a community has at most one running session,
/// or none. Everything it emits is invented and marked [DataOrigin.mock].
/// Media is Unavailable in the demo exactly as in every build
/// (lib/data/media/live_media_seams.dart) — this repository is data only.
class MockLiveRepository implements LiveRepository {
  MockLiveRepository({
    this.latency = AppConfig.fakeLatency,
    this.clock = DateTime.now,
    Set<String>? liveCommunityIds,
  }) : _live = liveCommunityIds ?? const {'mock-community-live'};

  final Duration latency;

  /// "Now", for when a demo session started. A test may fix it.
  final DateTime Function() clock;

  /// The communities the demo shows as having a session running now.
  final Set<String> _live;

  @override
  Future<LiveSession?> currentSession(String communityId) async {
    await Future<void>.delayed(latency);
    if (!_live.contains(communityId)) return null;
    return LiveSession(
      id: 'mock-session-$communityId',
      communityId: communityId,
      state: LiveSessionState.live,
      hostUserId: 'mock-teacher',
      startedAt: clock().subtract(const Duration(minutes: 12)),
      speakerCount: 1,
      me: const LiveMe(role: LiveParticipantRole.listener),
      origin: DataOrigin.mock,
    );
  }

  @override
  Future<LiveSession> getSession(String sessionId) async {
    await Future<void>.delayed(latency);
    return LiveSession(
      id: sessionId,
      communityId: 'mock-community-live',
      state: LiveSessionState.live,
      hostUserId: 'mock-teacher',
      startedAt: clock().subtract(const Duration(minutes: 12)),
      speakerCount: 1,
      me: const LiveMe(role: LiveParticipantRole.listener),
      origin: DataOrigin.mock,
    );
  }

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) async {
    await Future<void>.delayed(latency);
    // One page, then nothing: a deterministic, finite demo queue.
    if (cursor != null) {
      return const LiveHandsPage(
        items: [],
        nextCursor: null,
        origin: DataOrigin.mock,
      );
    }
    if (state == LiveHandsFilter.granted) {
      return LiveHandsPage(
        items: [
          LiveHand(
            id: 'mock-hand-granted',
            sessionId: sessionId,
            userId: 'mock-student-a',
            state: SpeakerRequestState.granted,
            requestedAt: clock().subtract(const Duration(minutes: 5)),
            grantedAt: clock().subtract(const Duration(minutes: 4)),
            decidedAt: clock().subtract(const Duration(minutes: 4)),
            displayName: 'طالب (تجريبي)',
            media: LiveObservedMedia.connected,
          ),
        ],
        nextCursor: null,
        origin: DataOrigin.mock,
      );
    }
    return LiveHandsPage(
      items: [
        LiveHand(
          id: 'mock-hand-1',
          sessionId: sessionId,
          userId: 'mock-student-b',
          state: SpeakerRequestState.pending,
          requestedAt: clock().subtract(const Duration(minutes: 2)),
          displayName: 'طالبة (تجريبي)',
        ),
      ],
      nextCursor: null,
      origin: DataOrigin.mock,
    );
  }
}
