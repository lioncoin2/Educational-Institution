import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/live.dart';
import '../../../data/models/live_room.dart';
import '../live_copy.dart';
import '../state/live_reactions_controller.dart';

/// How each of the four reactions looks — icons, not emoji, so they render the
/// same on every platform (CanvasKit fetches no emoji font).
IconData liveReactionIcon(LiveReactionKind kind) => switch (kind) {
  LiveReactionKind.heart => Icons.favorite_rounded,
  LiveReactionKind.thumbsUp => Icons.thumb_up_rounded,
  LiveReactionKind.clap => Icons.sign_language_rounded,
  LiveReactionKind.smile => Icons.emoji_emotions_rounded,
};

Color liveReactionColor(BuildContext context, LiveReactionKind kind) =>
    switch (kind) {
      LiveReactionKind.heart => const Color(0xFFE5484D),
      LiveReactionKind.thumbsUp => context.colors.primary,
      LiveReactionKind.clap => const Color(0xFFF5A524),
      LiveReactionKind.smile => const Color(0xFFF5A524),
    };

/// Whether the viewer may react: the session is live and the server lets them
/// take part (`me.canJoin`) or moderate it. A hint — the server decides afresh
/// on every reaction.
bool liveCanReact(LiveSession session) =>
    session.isLive && (session.me.canJoin || session.me.canModerate);

/// Sends [kind] for the viewer, saying a refusal through the server's code.
Future<void> sendLiveReaction(
  BuildContext context,
  WidgetRef ref,
  String sessionId,
  LiveReactionKind kind,
) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    await ref.read(liveReactionsProvider(sessionId).notifier).send(kind);
  } on LiveException catch (error) {
    messenger.toast(LiveCopy.commandError(error.code));
  } on Object {
    messenger.toast(LiveCopy.commandError(null));
  }
}

/// The reactions strip (ADR 0049): the room's four reactions — ❤️ 👍 👏 😊 —
/// one tap each, for the session's participants. A viewer the server does not
/// let take part sees the strip muted and inert, with words that say why.
class LiveReactionBar extends ConsumerWidget {
  const LiveReactionBar({super.key, required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = liveCanReact(session);
    final colors = context.colors;
    return Semantics(
      container: true,
      label: enabled
          ? LiveCopy.reactionsLabel
          : '${LiveCopy.reactionsLabel} — ${LiveCopy.reactionsForParticipants}',
      child: Opacity(
        opacity: enabled ? 1 : 0.6,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            for (final kind in LiveReactionKind.values) ...[
              Tooltip(
                message: LiveCopy.reactionLabel(kind),
                child: Semantics(
                  button: true,
                  enabled: enabled,
                  label: LiveCopy.reactionLabel(kind),
                  child: InkWell(
                    key: Key('live-react-${kind.wire}'),
                    customBorder: const CircleBorder(),
                    onTap: enabled
                        ? () => sendLiveReaction(context, ref, session.id, kind)
                        : null,
                    child: Container(
                      padding: const EdgeInsets.all(Insets.sm),
                      decoration: BoxDecoration(
                        color: colors.surfaceContainerHigh,
                        shape: BoxShape.circle,
                        border: Border.all(color: colors.outlineVariant),
                      ),
                      child: Icon(
                        liveReactionIcon(kind),
                        size: 20,
                        color: enabled
                            ? liveReactionColor(context, kind)
                            : colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
              ),
              if (kind != LiveReactionKind.values.last)
                const SizedBox(width: Insets.sm),
            ],
          ],
        ),
      ),
    );
  }
}

/// The reactions as they happen, floating up the stage's end edge — the
/// viewer's own and everyone else's (who sent them is never shown, nor known
/// to the app). Pointer-transparent: it never takes a tap from the stage.
/// Reduced motion: each simply fades where it appears.
class LiveReactionOverlay extends ConsumerWidget {
  const LiveReactionOverlay({super.key, required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bursts = ref.watch(liveReactionsProvider(sessionId));
    final still = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    return IgnorePointer(
      child: ExcludeSemantics(
        child: SizedBox(
          width: 72,
          height: 220,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              for (final burst in bursts)
                _Burst(key: ValueKey(burst.id), burst: burst, still: still),
            ],
          ),
        ),
      ),
    );
  }
}

class _Burst extends StatelessWidget {
  const _Burst({super.key, required this.burst, required this.still});

  final LiveReactionBurst burst;
  final bool still;

  @override
  Widget build(BuildContext context) {
    // A small, stable sideways drift per burst, so a flurry does not stack.
    final drift = ((burst.id.hashCode % 7) - 3) * 4.0;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: LiveReactionsController.shown,
      builder: (context, t, child) {
        final rise = still ? 0.0 : t * 170;
        final sway = still ? 0.0 : math.sin(t * math.pi * 2) * 6 + drift;
        final opacity = t < 0.7 ? 1.0 : ((1 - t) / 0.3).clamp(0.0, 1.0);
        return PositionedDirectional(
          bottom: rise,
          end: 16 + sway,
          child: Opacity(opacity: opacity, child: child),
        );
      },
      child: Icon(
        key: Key('live-reaction-burst-${burst.kind.wire}'),
        liveReactionIcon(burst.kind),
        size: burst.mine ? 34 : 30,
        color: liveReactionColor(context, burst.kind),
        shadows: const [Shadow(blurRadius: 6, color: Colors.black54)],
      ),
    );
  }
}
