import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/theme/live_palette.dart';
import '../../../data/media/livekit/livekit_screen_share_view.dart';
import '../../../data/models/live.dart';
import '../../../data/models/live_media.dart';
import '../live_copy.dart';
import '../state/live_media_controller.dart';
import 'live_screen_share_viewer.dart';

/// The immersive broadcast STAGE (reference: the large presenter/media surface
/// that fills the room). It renders the real media the platform supports — a
/// presenter's SHARED SCREEN when one is live — and otherwise an honest
/// audio-first on-air emblem (the camera is never a source, so a fake presenter
/// video would mislead). Over it float the top bar (back, «مباشر», the live
/// speaker count, the participants button) and a bottom "now" label.
///
/// Presentational: it reads the already-fetched [LiveSession] and the media
/// seam's remote participants; it drives no command and fabricates no data.
class LiveStage extends ConsumerWidget {
  const LiveStage({super.key, required this.session, this.onParticipants});

  final LiveSession session;

  /// Opens the participants sheet (mobile). Null on desktop, where the roster is
  /// a side pane and the button is unnecessary.
  final VoidCallback? onParticipants;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remotes = ref.watch(liveRemoteParticipantsProvider).asData?.value;
    LiveRemoteParticipant? sharing;
    if (remotes != null) {
      for (final remote in remotes.values) {
        if (remote.screenSharing) {
          sharing = remote;
          break;
        }
      }
    }

    return ClipRRect(
      borderRadius: Radii.brLg,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [LivePalette.stageTop, LivePalette.stageBottom],
          ),
          border: Border.all(color: context.colors.outlineVariant),
          borderRadius: Radii.brLg,
        ),
        child: Stack(
          fit: StackFit.expand,
          children: [
            // Media layer: the real shared screen (double tap → full screen),
            // else the audio on-air hero.
            if (sharing != null)
              GestureDetector(
                onDoubleTap: () =>
                    openLiveScreenShareViewer(context, sharing!.identity),
                child: Container(
                  key: const Key('live-screen-share'),
                  color: Colors.black,
                  child: LiveKitScreenShareView(
                    key: ValueKey('screen-${sharing.identity}'),
                    track: sharing.screenShareTrack,
                  ),
                ),
              )
            else
              Center(child: _OnAirEmblem(hostId: session.hostUserId)),

            // A soft scrim so the overlaid controls/labels stay legible. Over a
            // shared screen only a thin band under the top bar: the content
            // itself is never darkened.
            Positioned.fill(
              child: IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: sharing != null
                          ? const [LivePalette.scrim, Colors.transparent]
                          : const [
                              LivePalette.scrim,
                              Colors.transparent,
                              LivePalette.scrim,
                            ],
                      stops: sharing != null
                          ? const [0, 0.16]
                          : const [0, 0.4, 1],
                    ),
                  ),
                ),
              ),
            ),

            // Top bar.
            PositionedDirectional(
              top: Insets.sm,
              start: Insets.sm,
              end: Insets.sm,
              child: _TopBar(session: session, onParticipants: onParticipants),
            ),

            // "Sharing now" chip while a screen is live.
            if (sharing != null)
              PositionedDirectional(
                top: 56,
                start: Insets.md,
                child: _Chip(
                  icon: Icons.screen_share_rounded,
                  label: LiveCopy.liveScreenSharing,
                ),
              ),

            // Bottom "now" label — the session, the live speaker count, and the
            // viewer's own standing. Real values only. While a screen is shared
            // the content keeps that space, and a button opens it full screen.
            if (sharing == null)
              PositionedDirectional(
                bottom: Insets.md,
                start: Insets.md,
                end: Insets.md,
                child: _StageInfo(session: session),
              )
            else
              PositionedDirectional(
                bottom: Insets.sm,
                end: Insets.sm,
                child: _GlassIconButton(
                  key: const Key('live-screen-expand'),
                  icon: Icons.fullscreen_rounded,
                  tooltip: LiveCopy.liveScreenExpand,
                  onTap: () =>
                      openLiveScreenShareViewer(context, sharing!.identity),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({required this.session, this.onParticipants});

  final LiveSession session;
  final VoidCallback? onParticipants;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _GlassIconButton(
          icon: Icons.arrow_back_ios_new_rounded,
          tooltip: MaterialLocalizations.of(context).backButtonTooltip,
          onTap: () => Navigator.of(context).maybePop(),
        ),
        const SizedBox(width: Insets.xs),
        const _LivePill(),
        const Spacer(),
        _Chip(
          icon: Icons.graphic_eq_rounded,
          label: '${session.speakerCount}',
        ),
        if (onParticipants != null) ...[
          const SizedBox(width: Insets.xs),
          _GlassIconButton(
            key: const Key('live-stage-participants'),
            icon: Icons.groups_rounded,
            tooltip: LiveCopy.participantsTitle,
            onTap: onParticipants,
          ),
        ],
      ],
    );
  }
}

class _StageInfo extends StatelessWidget {
  const _StageInfo({required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context) {
    final me = session.me;
    final notes = <String>[
      if (me.isHost)
        LiveCopy.youHost
      else if (me.canModerate)
        LiveCopy.youModerate,
      if (me.presenting) LiveCopy.youPresent,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          LiveCopy.liveNow,
          style: context.text.titleMedium?.copyWith(color: Colors.white),
        ),
        const SizedBox(height: 2),
        Text(
          LiveCopy.speakers(session.speakerCount),
          style: context.text.bodySmall?.copyWith(color: Colors.white70),
        ),
        for (final note in notes) ...[
          const SizedBox(height: 2),
          Text(
            note,
            style: context.text.labelSmall?.copyWith(color: Colors.white70),
          ),
        ],
      ],
    );
  }
}

/// The "مباشر" pill — solid on-air with a static dot (no motion).
class _LivePill extends StatelessWidget {
  const _LivePill();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.md,
        vertical: Insets.xs,
      ),
      decoration: const BoxDecoration(
        color: LivePalette.onAir,
        borderRadius: Radii.pill,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: const BoxDecoration(
              color: LivePalette.onOnAir,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: Insets.xs),
          Text(
            LiveCopy.live,
            style: context.text.labelSmall?.copyWith(
              color: LivePalette.onOnAir,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

/// A translucent "glass" chip overlaid on the stage (icon + short label).
class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.sm,
        vertical: Insets.xs,
      ),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.42),
        borderRadius: Radii.pill,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: Colors.white),
          const SizedBox(width: Insets.xs),
          Text(
            label,
            style: context.text.labelSmall?.copyWith(color: Colors.white),
          ),
        ],
      ),
    );
  }
}

/// A round translucent icon button for the stage overlay. [locked] renders it
/// inert with a lock badge.
class _GlassIconButton extends StatelessWidget {
  const _GlassIconButton({
    super.key,
    required this.icon,
    required this.tooltip,
    this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: tooltip,
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(
            color: Colors.black.withValues(alpha: 0.42),
            shape: BoxShape.circle,
          ),
          alignment: Alignment.center,
          child: Icon(icon, size: 18, color: Colors.white),
        ),
      ),
    );
  }
}

/// A circular "on-air" audio emblem whose concentric glows REACT to the host's
/// live microphone level (`liveAudioLevelsProvider`, keyed by the session's
/// `hostUserId`): louder → larger/brighter glow, silence → rest. Driven only by
/// the SDK's active-speaker updates — there is NO timer moving it without sound.
/// Honours reduced motion (`MediaQuery.disableAnimations`): it then stays at the
/// resting size with no animation. The inner broadcast glyph is constant.
class _OnAirEmblem extends ConsumerWidget {
  const _OnAirEmblem({required this.hostId});

  final String hostId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final raw = ref
        .watch(liveAudioLevelsProvider)
        .value
        ?.levelFor(hostId) ??
        0.0;
    final level = raw.clamp(0.0, 1.0).toDouble();
    final reduceMotion = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final accent = context.colors.primary;

    // At rest (silence, or reduced motion) the glows sit at their base size and
    // opacity; the host's voice grows and brightens them.
    final active = !reduceMotion && level > 0.05;
    final outerScale = active ? 1.0 + level * 0.18 : 1.0;
    final midScale = active ? 1.0 + level * 0.10 : 1.0;
    final outerAlpha = active ? (0.10 + level * 0.18).clamp(0.10, 0.30) : 0.10;
    final midAlpha = active ? (0.18 + level * 0.18).clamp(0.18, 0.40) : 0.18;
    const d = Duration(milliseconds: 160);

    return SizedBox(
      width: 128,
      height: 128,
      child: Center(
        child: AnimatedScale(
          scale: outerScale,
          duration: d,
          curve: Curves.easeOut,
          child: AnimatedContainer(
            duration: d,
            width: 128,
            height: 128,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: accent.withValues(alpha: outerAlpha),
            ),
            alignment: Alignment.center,
            child: AnimatedScale(
              scale: midScale,
              duration: d,
              curve: Curves.easeOut,
              child: AnimatedContainer(
                duration: d,
                width: 96,
                height: 96,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: accent.withValues(alpha: midAlpha),
                ),
                alignment: Alignment.center,
                child: Container(
                  width: 68,
                  height: 68,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: context.colors.surfaceContainerHigh,
                    border: Border.all(color: accent, width: 2),
                  ),
                  alignment: Alignment.center,
                  child: Icon(Icons.graphic_eq_rounded, color: accent, size: 32),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
