import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/section_header.dart';
import '../../../data/models/live.dart';
import '../live_copy.dart';
import 'live_moderation_actions.dart';

/// The viewer's own hand in a running session: ask for the floor (raise a
/// hand), and lower it or yield the floor once it is up.
///
/// Shown only as the server's own `me` allows — [LiveMe.canRaiseHand] offers
/// the raise, and an active `me.hand` (pending or granted) offers the lower —
/// so a viewer the server does not permit sees nothing. Nothing here decides
/// who may speak, and no role is read. The command goes through
/// [LiveCommandButton] → [LiveModerationController] → the server, which decides
/// afresh; the authoritative `me.hand` then arrives through reconciliation, so
/// nothing is fabricated here. The floor permits speaking (audio), which is the
/// media seam — unavailable in this build — never a claim that audio flows.
class LiveHandControl extends StatelessWidget {
  const LiveHandControl({super.key, required this.session});

  final LiveSession session;

  /// A hand that is live for the viewer — raised and awaiting a decision, or
  /// holding the floor. A closed hand (declined, withdrawn, revoked, expired)
  /// is not active, so the raise control returns.
  static bool _isActive(LiveMyHand? hand) =>
      hand != null &&
      (hand.state == SpeakerRequestState.pending ||
          hand.state == SpeakerRequestState.granted);

  @override
  Widget build(BuildContext context) {
    final me = session.me;
    final hand = me.hand;
    final id = session.id;
    final active = _isActive(hand);

    // Nothing to offer: the server neither permits a raise nor reports an open
    // hand. (A moderator who speaks by right simply has no hand to raise.)
    if (!active && !me.canRaiseHand) return const SizedBox.shrink();

    final Widget body;
    if (active) {
      final granted = hand!.state == SpeakerRequestState.granted;
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            granted ? LiveCopy.handStatusGranted : LiveCopy.handStatusPending,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Insets.md),
          LiveCommandButton(
            key: const Key('live-lower-hand'),
            label: granted ? LiveCopy.yieldFloor : LiveCopy.lowerHand,
            icon: Icons.back_hand_outlined,
            successMessage: granted
                ? LiveCopy.yieldFloorDone
                : LiveCopy.lowerHandDone,
            action: (c) => c.lowerHand(id),
          ),
        ],
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            LiveCopy.raiseHandHint,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Insets.md),
          LiveCommandButton(
            key: const Key('live-raise-hand'),
            label: LiveCopy.raiseHand,
            icon: Icons.front_hand_outlined,
            successMessage: LiveCopy.raiseHandDone,
            action: (c) => c.raiseHand(id),
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Insets.xxl),
        const SectionHeader(title: LiveCopy.handSection),
        const SizedBox(height: Insets.md),
        body,
      ],
    );
  }
}
