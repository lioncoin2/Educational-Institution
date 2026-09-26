import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/stat_badge.dart';
import '../../../data/models/communities.dart';
import '../community_copy.dart';
import 'community_change.dart';

/// One invitation link, as those who manage the links see it: the state the
/// server gives it, when it ends, how often it was used (of how many, when
/// it has a limit), and whether the viewer made it — never its token, which
/// nobody holds any more, and never who else made it.
class InvitationTile extends StatelessWidget {
  const InvitationTile({
    super.key,
    required this.invitation,
    required this.mine,
    this.onRevoke,
    this.revoking = false,
  });

  final CommunityInvitation invitation;

  /// The viewer made it — the session's account, compared, never shown.
  final bool mine;

  /// Null when it is not the viewer's to revoke, or revoked already.
  final VoidCallback? onRevoke;

  /// Its revocation is on its way.
  final bool revoking;

  @override
  Widget build(BuildContext context) {
    final active = invitation.state == InvitationState.active;
    return AppCard(
      padding: const EdgeInsets.all(Insets.md),
      semanticLabel: CommunityCopy.invitationLabel(
        context,
        invitation,
        mine: mine,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            alignment: AlignmentDirectional.center,
            decoration: BoxDecoration(
              color: context.colors.secondaryContainer,
              shape: BoxShape.circle,
            ),
            child: Icon(
              active ? Icons.link_rounded : Icons.link_off_rounded,
              size: 20,
              color: context.colors.onSecondaryContainer,
            ),
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: Insets.sm,
                  runSpacing: Insets.xs,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    StatBadge(
                      label: CommunityCopy.invitationState(invitation.state),
                      tone: active ? StatBadgeTone.success : StatBadgeTone.soft,
                    ),
                    if (mine)
                      Text(
                        CommunityCopy.createdByYou,
                        style: context.text.labelSmall?.copyWith(
                          color: context.colors.primary,
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: Insets.xs),
                Text(
                  CommunityCopy.expiry(context, invitation.expiresAt),
                  style: context.text.bodySmall,
                ),
                Text(
                  CommunityCopy.uses(invitation),
                  style: context.text.bodySmall,
                ),
              ],
            ),
          ),
          if (onRevoke != null || revoking) ...[
            const SizedBox(width: Insets.sm),
            IconButton(
              tooltip: CommunityCopy.revokeLink,
              onPressed: revoking ? null : onRevoke,
              icon: revoking
                  ? const BusyIndicator()
                  : const Icon(Icons.link_off_rounded),
            ),
          ],
        ],
      ),
    );
  }
}
