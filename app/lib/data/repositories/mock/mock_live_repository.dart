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

  // ── Moderator commands ─────────────────────────────────────────────────
  // Deterministic, invented, mock-flagged — the demo's answer to each command.
  // No media happens here (media is Unavailable in every build); these only
  // echo the shape the server would.

  @override
  Future<LiveSession> endSession(String sessionId) async {
    await Future<void>.delayed(latency);
    final now = clock();
    return LiveSession(
      id: sessionId,
      communityId: 'mock-community-live',
      state: LiveSessionState.ended,
      hostUserId: 'mock-teacher',
      startedAt: now.subtract(const Duration(minutes: 20)),
      endedAt: now,
      endReason: LiveSessionEndReason.moderator,
      speakerCount: 0,
      me: const LiveMe(
        role: LiveParticipantRole.moderator,
        canModerate: true,
        canEnd: true,
      ),
      origin: DataOrigin.mock,
    );
  }

  @override
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  }) async {
    await Future<void>.delayed(latency);
    return true; // the demo's participant was "connected"
  }

  @override
  Future<bool> resetRoom(String sessionId) async {
    await Future<void>.delayed(latency);
    return true; // the demo's room moved on
  }

  @override
  Future<LiveSession> claimPresenter(String sessionId) =>
      _presenting(sessionId, const ['mock-teacher']);

  @override
  Future<LiveSession> stopPresenter(String sessionId) =>
      _presenting(sessionId, const []);

  @override
  Future<LiveSession> grantPresenter(String sessionId, String userId) =>
      _presenting(sessionId, [userId]);

  @override
  Future<LiveSession> revokePresenter(String sessionId, String userId) =>
      _presenting(sessionId, const []);

  /// A running demo session with the given presenters — the shape a presenter
  /// command answers with.
  Future<LiveSession> _presenting(
    String sessionId,
    List<String> presenterUserIds,
  ) async {
    await Future<void>.delayed(latency);
    return LiveSession(
      id: sessionId,
      communityId: 'mock-community-live',
      state: LiveSessionState.live,
      hostUserId: 'mock-teacher',
      startedAt: clock().subtract(const Duration(minutes: 12)),
      speakerCount: 1,
      presenterUserIds: presenterUserIds,
      me: const LiveMe(
        role: LiveParticipantRole.moderator,
        canModerate: true,
        canPresent: true,
      ),
      origin: DataOrigin.mock,
    );
  }
}
