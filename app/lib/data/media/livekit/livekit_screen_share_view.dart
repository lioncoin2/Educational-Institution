import 'package:flutter/material.dart';
import 'package:livekit_client/livekit_client.dart';

/// Renders a remote screen-share [track] — the opaque handle the media seam
/// carries on `LiveRemoteParticipant.screenShareTrack`. Confined to the LiveKit
/// adapter directory so `package:livekit_client` never reaches the feature
/// layer (ADR 0030; enforced by `test/live/live_boundaries_test.dart`).
///
/// A null handle, or one that is not a LiveKit [VideoTrack], renders nothing —
/// so a build with no real media (the Unavailable seam, every widget test)
/// stays safe and simply shows no picture.
class LiveKitScreenShareView extends StatelessWidget {
  const LiveKitScreenShareView({super.key, required this.track});

  final Object? track;

  @override
  Widget build(BuildContext context) {
    final video = track;
    if (video is! VideoTrack) return const SizedBox.shrink();
    return VideoTrackRenderer(video, fit: VideoViewFit.contain);
  }
}
