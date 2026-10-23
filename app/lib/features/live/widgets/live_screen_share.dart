import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/media/livekit/livekit_screen_share_view.dart';
import '../live_copy.dart';
import '../state/live_media_controller.dart';

/// The broadcaster's shared screen, as eligible participants see it
/// (Requirement B). It reads only the media seam's remote participants — a
/// publication fact, never presenter authority — and shows nothing when no one
/// is sharing. The pixels are painted by the LiveKit adapter's render widget;
/// this feature layer stays free of the media SDK (ADR 0030).
///
/// Platform / provider support is implicit: with no real provider bound (the
/// Unavailable seam, a native build, or a build without live media) the seam
/// reports no remote participants, so nothing is shown — the shared screen is
/// never advertised where the platform cannot render it.
class LiveScreenShare extends ConsumerWidget {
  const LiveScreenShare({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remotes = ref.watch(liveRemoteParticipantsProvider).asData?.value;
    if (remotes == null) return const SizedBox.shrink();
    final sharing = [
      for (final remote in remotes.values)
        if (remote.screenSharing) remote,
    ];
    if (sharing.isEmpty) return const SizedBox.shrink();
    final presenter = sharing.first;
    return Padding(
      key: const Key('live-screen-share'),
      padding: const EdgeInsets.only(bottom: Insets.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(
                Icons.screen_share_rounded,
                size: 18,
                color: context.colors.primary,
              ),
              const SizedBox(width: Insets.xs),
              Expanded(
                child: Text(
                  LiveCopy.liveScreenSharing,
                  style: context.text.labelLarge,
                ),
              ),
            ],
          ),
          const SizedBox(height: Insets.xs),
          ClipRRect(
            borderRadius: Radii.brMd,
            child: AspectRatio(
              aspectRatio: 16 / 9,
              child: ColoredBox(
                color: context.colors.surfaceContainerHighest,
                child: LiveKitScreenShareView(
                  key: ValueKey('screen-${presenter.identity}'),
                  track: presenter.screenShareTrack,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
