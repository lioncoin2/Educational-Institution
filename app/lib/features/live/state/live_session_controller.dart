import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/live.dart';
import '../../../providers/app_providers.dart';

/// Loads a community's current live session, read-only.
///
/// The state is the running session, or null when none is live now; loading
/// and error are the [AsyncValue] around it. One read per build, re-run on
/// [refresh] and when the signed-in account changes. No realtime and no media:
/// this foundation shows the session, and media participation is a separate
/// seam (lib/data/media/live_media_seams.dart) the screen reads on its own.
/// What the viewer may do is the server's `me`, never worked out here.
class LiveSessionController extends AsyncNotifier<LiveSession?> {
  LiveSessionController(this.communityId);

  final String communityId;

  @override
  Future<LiveSession?> build() async {
    // A different signed-in viewer is a different answer: read again when the
    // account changes, not merely when the session resolves to the same one.
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    final repository = ref.watch(liveRepositoryProvider);
    return repository.currentSession(communityId);
  }

  /// Reads the current session again. A failure surfaces to the screen's retry.
  Future<void> refresh() {
    ref.invalidateSelf();
    return future.then<void>((_) {}, onError: (Object _) {});
  }
}

final liveSessionProvider = AsyncNotifierProvider.autoDispose
    .family<LiveSessionController, LiveSession?, String>(
      LiveSessionController.new,
      retry: (_, _) => null,
    );
