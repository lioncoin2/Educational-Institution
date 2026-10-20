import '../../../app/app_config.dart';
import '../../models/data_origin.dart';
import '../../models/live.dart';
import '../../models/live_media.dart';
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
  }) : _live = {
         ...(liveCommunityIds ?? const {'mock-community-live'}),
       };

  final Duration latency;

  /// "Now", for when a demo session started. A test may fix it.
  final DateTime Function() clock;

  /// The communities the demo shows as having a session running now. Mutable:
  /// [start] adds to it, so a started session is then discoverable.
  final Set<String> _live;

  /// The demo viewer's own raised hand, or null. [raiseHand]/[lowerHand] move
  /// it, and the session reads reflect it in `me` — so the demo's raise/lower
  /// control is coherent without a realtime feed. Moderating OTHER people's
  /// hands (grant/decline/revoke) is echoed but not persisted into the queue,
  /// exactly as the demo's other moderator commands are.
  LiveMyHand? _myHand;

  @override
  Future<LiveSession> start(String communityId) async {
    await Future<void>.delayed(latency);
    // The caller becomes the host; from now on the community has a running
    // session, so currentSession answers it.
    _live.add(communityId);
    return LiveSession(
      id: 'mock-session-$communityId',
      communityId: communityId,
      state: LiveSessionState.live,
      hostUserId: 'mock-teacher',
      startedAt: clock(),
      speakerCount: 1,
      me: const LiveMe(
        role: LiveParticipantRole.moderator,
        isHost: true,
        canModerate: true,
        canEnd: true,
        canPresent: true,
      ),
      origin: DataOrigin.mock,
    );
  }

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
      me: _listenerMe,
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
      me: _listenerMe,
      origin: DataOrigin.mock,
    );
  }

  /// The demo listener's `me`: may raise a hand while none is up, and carries
  /// the raised hand once it is — so the raise/lower control demonstrates both.
  LiveMe get _listenerMe => LiveMe(
    role: LiveParticipantRole.listener,
    canRaiseHand: _myHand == null,
    hand: _myHand,
  );

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

  // ── Speaking: the floor (raise a hand, and moderate it) ─────────────────
  // The viewer's own hand is remembered (so the control is coherent); echoing
  // a moderator's grant/decline/revoke of ANOTHER person's hand does not mutate
  // the demo queue, like the demo's other moderator commands. No media happens.

  @override
  Future<LiveHand> raiseHand(String sessionId) async {
    await Future<void>.delayed(latency);
    final hand = LiveHand(
      id: 'mock-hand-self-$sessionId',
      sessionId: sessionId,
      userId: 'mock-self',
      state: SpeakerRequestState.pending,
      requestedAt: clock(),
    );
    _myHand = LiveMyHand(requestId: hand.id, state: hand.state);
    return hand;
  }

  @override
  Future<LiveHand?> lowerHand(String sessionId) async {
    await Future<void>.delayed(latency);
    final had = _myHand;
    _myHand = null;
    if (had == null) return null;
    return LiveHand(
      id: had.requestId,
      sessionId: sessionId,
      userId: 'mock-self',
      state: SpeakerRequestState.withdrawn,
      requestedAt: clock(),
      decidedAt: clock(),
    );
  }

  @override
  Future<LiveHand> grantFloor(String requestId) =>
      _decided(requestId, SpeakerRequestState.granted, granted: true);

  @override
  Future<LiveHand> declineHand(String requestId) =>
      _decided(requestId, SpeakerRequestState.declined);

  @override
  Future<LiveHand> revokeFloor(String requestId) =>
      _decided(requestId, SpeakerRequestState.revoked);

  /// A moderator's decision on a hand, echoed as the server would answer — the
  /// request in its new state. The demo queue itself is not mutated.
  Future<LiveHand> _decided(
    String requestId,
    SpeakerRequestState state, {
    bool granted = false,
  }) async {
    await Future<void>.delayed(latency);
    final now = clock();
    return LiveHand(
      id: requestId,
      sessionId: 'mock-session-mock-community-live',
      userId: 'mock-student-b',
      state: state,
      requestedAt: now.subtract(const Duration(minutes: 2)),
      grantedAt: granted ? now : null,
      decidedAt: now,
      displayName: 'طالبة (تجريبي)',
    );
  }

  // ── Media ──────────────────────────────────────────────────────────────

  @override
  Future<LiveMediaGrant> join(String sessionId) async {
    await Future<void>.delayed(latency);
    final now = clock();
    // A deterministic, deliberately UNUSABLE credential: never JWT-shaped, a
    // `.invalid` host — nothing a real media client would accept. The demo
    // never carries live audio (media is Unavailable in every build).
    return LiveMediaGrant(
      sessionId: sessionId,
      token: 'mock-join-not-a-real-token',
      url: 'wss://live.mock.invalid',
      expiresInSeconds: 120,
      expiresAt: now.add(const Duration(seconds: 120)),
      role: LiveParticipantRole.listener,
      microphone: false,
      screen: false,
      screenAudio: false,
    );
  }

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
