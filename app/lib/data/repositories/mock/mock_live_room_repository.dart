import '../../models/live_room.dart';
import '../repositories.dart';

/// The demo build's live room (C15): nobody has a picture (initials
/// everywhere), and a reaction is accepted and goes nowhere — there is no one
/// else in a demo room to see it. Records what it was asked, for tests.
class MockLiveRoomRepository implements LiveRoomRepository {
  final List<String> calls = [];

  @override
  Future<Uri?> participantAvatarUrl(String sessionId, String userId) async {
    calls.add('avatar:$sessionId:$userId');
    return null;
  }

  @override
  Future<void> react(String sessionId, LiveReactionKind kind) async {
    calls.add('react:$sessionId:${kind.wire}');
  }
}
