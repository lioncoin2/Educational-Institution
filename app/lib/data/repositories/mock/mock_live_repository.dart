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
}
