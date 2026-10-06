/// The live-session media seam.
///
/// This build has no live audio. Joining a room, speaking and hearing are a
/// native-media concern (LiveKit, which pulls in `flutter_webrtc`), and a
/// native dependency is never added blind — it cannot be built or verified on
/// a device from here (see lib/data/media/media_seams.dart, and the guard in
/// test/live/live_boundaries_test.dart).
///
/// So media participation lives behind this interface, with an "Unavailable"
/// default: the live-session screen is built and tested against the seam and
/// states plainly that audio is not available yet. When live audio lands it
/// lands here — behind this same seam, bound in one provider, as its own
/// reviewed change — and no screen that composes the seam has to change.
library;

/// Whether this build can take part in a live session's media (audio).
abstract interface class LiveMediaClient {
  /// False until a real media client is bound — a later, reviewed change.
  bool get isAvailable;
}

/// The default: no media. There is nothing to join and nothing to hear, and
/// the UI says so rather than pretending otherwise.
class UnavailableLiveMediaClient implements LiveMediaClient {
  const UnavailableLiveMediaClient();

  @override
  bool get isAvailable => false;
}
